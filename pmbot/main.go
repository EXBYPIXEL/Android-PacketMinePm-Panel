// pmbot - PMPanel fake player engine.
//
// A tiny manager process that connects REAL Bedrock protocol clients to a
// PocketMine-MP (or any Bedrock) server. Runs on Android (spawned from the
// app's nativeLibraryDir) or desktop for testing.
//
// Protocol on stdin: one JSON object per line (ops).
// Protocol on stdout: one JSON object per line (events).
//
// The engine speaks the protocol compiled into gophertunnel (protocol 2225 =
// Minecraft 1.26.60), matching the NG-PocketMine-MP build bundled with the app.
//
// v2.1.0 multiversion remote join:
//   - wire-only protocol adapters (github.com/shawtymarco/go-multiversion) let
//     bots join servers running OLDER Minecraft releases: 1.21.40-1.21.51,
//     1.21.100-1.21.132, 1.26.0-1.26.52, plus the native 1.26.60. The server's
//     protocol is auto-detected from the preflight pong and the matching adapter
//     is used for the dial - joining a public 1.21.50 server now works.
//   - version-mismatch failures now list every supported version, and the pong
//     compat check treats adapter-covered versions as compatible.
//   - client JWT GameVersion follows the dialed protocol so old servers see a
//     matching client string.
//
// v2.0.2 remote-join fixes:
//   - preflight ping per target: version mismatch is detected BEFORE dialing
//     (clear "version" error instead of a cryptic handshake timeout) and the
//     pong's redirect port is verified; a stale/foreign redirect port no longer
//     breaks the dial (NAT / port-forwarded servers).
//   - every dial failure is classified (version/xbox/full/banned/...) so the
//     UI can show a helpful Persian message.
//   - optional REAL Xbox Live sign-in (device code, same XAL flow as the
//     official Android client) so bots can join servers with xbox-auth on.
//
// v2.2.0 reliability fix (revert of the 2.0.2 "faster spawn" experiment):
//   - the adaptive 120/200 ms spawn stagger starved the phone CPU on large
//     batches (200 bots -> ~70 joined, the rest timed out, then the server
//     kicked everyone because keepalives starved too). The inter-bot gap is
//     back to the proven fixed 350 ms pacing of v2.0.1 - the build where 100
//     bots joined comfortably.
//   - remote dials get a 60 s budget (loopback keeps 30 s): over the internet
//     RakNet resends + adapter conversion + server spawn simply take longer
//     than a loopback handshake, and the old 25 s deadline turned that into
//     "cannot join public servers at all".
//   - gophertunnel's internal error log was discarded - real protocol/decode
//     errors during the dial vanished and the bot just hung to the deadline.
//     The engine's ErrorLog now surfaces those lines in the UI join log.
//   - one automatic retry for transient dial failures (timeout/refused/
//     incompatible): a single lossy handshake attempt over WAN no longer means
//     a dead bot. Definitive failures (version/full/banned/xbox) never retry.
//
// v2.3.0 resource pack fetcher ("getpacks" op):
//   - joins a PUBLIC Bedrock server exactly like the bots do, but instead of
//     staying online it saves every resource pack the server pushes onto its
//     players as .mcpack files and disconnects. This powers the panel's
//     "server pack download" tool: paste a public server address, get its
//     packs - no URL guessing.
//   - packs are written under their manifest name ("<Name> v<version>.mcpack")
//     into the directory the panel passes, with a packs-index.json sidecar so
//     repeat fetches skip packs that are already saved (the server is told the
//     client "has" them, exactly like a returning player).
//   - live progress events: connecting, per-pack downloading/cached, byte
//     counter while chunks stream in, packdone per saved pack, done/error.
package main

import (
        "bufio"
        "context"
        "crypto/ecdsa"
        "crypto/elliptic"
        cryptorand "crypto/rand"
        "encoding/base64"
        "encoding/json"
        "errors"
        "fmt"
        "io"
        "log/slog"
        "math/rand"
        "net"
        "net/http"
        "os"
        "os/signal"
        "path/filepath"
        "regexp"
        "sort"
        "strconv"
        "strings"
        "sync"
        "sync/atomic"
        "syscall"
        "time"

        "github.com/df-mc/go-xsapi/v2"
        "github.com/google/uuid"
        "github.com/sandertv/go-raknet"
        "github.com/sandertv/gophertunnel/minecraft"
        "github.com/sandertv/gophertunnel/minecraft/auth"
        "github.com/sandertv/gophertunnel/minecraft/protocol"
        "github.com/sandertv/gophertunnel/minecraft/protocol/login"
        "github.com/sandertv/gophertunnel/minecraft/protocol/packet"
        "github.com/sandertv/gophertunnel/minecraft/resource"
        mv12140 "github.com/shawtymarco/go-multiversion/protocols/v1_21_40"
        mv12150 "github.com/shawtymarco/go-multiversion/protocols/v1_21_50"
        mv121100 "github.com/shawtymarco/go-multiversion/protocols/v1_21_100"
        mv121110 "github.com/shawtymarco/go-multiversion/protocols/v1_21_110"
        mv121130 "github.com/shawtymarco/go-multiversion/protocols/v1_21_130"
        mv1260 "github.com/shawtymarco/go-multiversion/protocols/v1_26_0"
        mv12610 "github.com/shawtymarco/go-multiversion/protocols/v1_26_10"
        mv12620 "github.com/shawtymarco/go-multiversion/protocols/v1_26_20"
        mv12630 "github.com/shawtymarco/go-multiversion/protocols/v1_26_30"
        mv12644 "github.com/shawtymarco/go-multiversion/protocols/v1_26_44"
        mv12645 "github.com/shawtymarco/go-multiversion/protocols/v1_26_45"
        mv12650 "github.com/shawtymarco/go-multiversion/protocols/v1_26_50"
        "golang.org/x/oauth2"
)

const (
        engineVersion = "2.3.0"
        // Fixed 350 ms gap between bot dials - the v2.0.1 pacing that reliably
        // joined 100 bots. The 2.0.2 adaptive 120/200 ms scheme overlapped too
        // many handshakes on a phone and mass joins collapsed (timeouts + mass
        // kick). Do not lower this without a full-scale device test.
        spawnStagger    = 350 * time.Millisecond
        maxBots         = 200
        cmdRateInterval = 60 * time.Millisecond // min gap between writes to one bot
        preflightTTL    = 5 * time.Minute

        // Per-attempt dial budgets. Loopback never loses packets and always
        // finishes in seconds; over the internet the same handshake must
        // survive RakNet resends under loss, so remote gets a much wider slot.
        dialTimeoutLocal  = 30 * time.Second
        dialTimeoutRemote = 60 * time.Second
)

// ---------------------------------------------------------------------------
// multiversion support - wire-only gophertunnel adapters for older Minecraft
// releases. A bot dials with the adapter matching the server's wire protocol,
// so public servers no longer need to run the engine's own version. The
// native protocol (2225 / MC 1.26.60) is gophertunnel itself, not listed here.
// ---------------------------------------------------------------------------

var versionAdapters = map[int32]minecraft.Protocol{
        748:  mv12140.New(),  // MC 1.21.40 - 1.21.44
        766:  mv12150.New(),  // MC 1.21.50 - 1.21.51
        827:  mv121100.New(), // MC 1.21.100 - 1.21.102
        844:  mv121110.New(), // MC 1.21.110 - 1.21.114
        898:  mv121130.New(), // MC 1.21.130 - 1.21.132
        924:  mv1260.New(),   // MC 1.26.0 - 1.26.3
        944:  mv12610.New(),  // MC 1.26.10 - 1.26.14
        975:  mv12620.New(),  // MC 1.26.20 - 1.26.23
        1001: mv12630.New(),  // MC 1.26.30 - 1.26.36
        2168: mv12644.New(),  // MC 1.26.40 - 1.26.44
        2169: mv12645.New(),  // MC 1.26.45
        2193: mv12650.New(),  // MC 1.26.50 - 1.26.52
}

// protocolFor returns the Protocol implementation to dial with for a server
// speaking the given wire protocol plus its Minecraft version string.
// p==nil means the native gophertunnel protocol. found=false means no native
// or adapter implementation covers that protocol.
func protocolFor(proto int64) (p minecraft.Protocol, ver string, found bool) {
        if int32(proto) == protocol.CurrentProtocol {
                return nil, protocol.CurrentVersion, true
        }
        if a, ok := versionAdapters[int32(proto)]; ok {
                return a, a.Ver(), true
        }
        return nil, "", false
}

// isSupportedProto reports whether a wire protocol can be joined.
func isSupportedProto(proto int64) bool {
        _, _, ok := protocolFor(proto)
        return ok
}

// supportedVersionsText lists every protocol the engine speaks, newest first,
// for version-mismatch errors: "1.26.60 (2225), 1.26.50 (2193), ...".
func supportedVersionsText() string {
        ids := make([]int, 0, len(versionAdapters)+1)
        ids = append(ids, int(protocol.CurrentProtocol))
        for id := range versionAdapters {
                ids = append(ids, int(id))
        }
        sort.Ints(ids)
        parts := make([]string, 0, len(ids))
        for i := len(ids) - 1; i >= 0; i-- {
                id := int32(ids[i])
                if id == protocol.CurrentProtocol {
                        parts = append(parts, fmt.Sprintf("%s (%d)", protocol.CurrentVersion, id))
                        continue
                }
                parts = append(parts, fmt.Sprintf("%s (%d)", versionAdapters[id].Ver(), id))
        }
        return strings.Join(parts, ", ")
}

// ---------------------------------------------------------------------------
// output helper - never block, always flush, one JSON object per line
// ---------------------------------------------------------------------------

var outMu sync.Mutex
var out = bufio.NewWriter(os.Stdout)

// debug mode: dump received packet types as log events (PMBOT_DEBUG=1)
var debug = os.Getenv("PMBOT_DEBUG") == "1"

// package-level manager, used by Bot helpers (listener routing)
var mgr = NewManager()

func emit(v map[string]any) {
        outMu.Lock()
        defer outMu.Unlock()
        b, err := json.Marshal(v)
        if err != nil {
                return
        }
        _, _ = out.Write(b)
        _, _ = out.Write([]byte("\n"))
        _ = out.Flush()
}

func emitLog(text string) { emit(map[string]any{"ev": "log", "text": text}) }

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

type Bot struct {
        name     string
        addr     string
        conn     *minecraft.Conn
        state    string // joining | online | left | failed
        msg      string // last status message
        code     string // failure classification for the UI (version/xbox/...)
        gamertag string // Xbox gamertag when joined with a real account
        key      *ecdsa.PrivateKey
        proto    minecraft.Protocol // wire adapter for older servers (nil = native)
        protoVer string             // Minecraft version this dial presents ("" = native)
        writeMu  sync.Mutex
        lastSay  time.Time
        stopOnce sync.Once
}

func (b *Bot) setState(state, msg string) {
        b.setStateCode(state, msg, "")
}

// setStateCode publishes a status event; code is an optional failure class the
// UI maps to a localized message.
func (b *Bot) setStateCode(state, msg, code string) {
        b.state = state
        b.msg = msg
        b.code = code
        ev := map[string]any{"ev": "status", "name": b.name, "state": state, "msg": msg}
        if code != "" {
                ev["code"] = code
        }
        if b.gamertag != "" {
                ev["gamertag"] = b.gamertag
        }
        emit(ev)
}

// sendText sends a chat message as the bot.
func (b *Bot) sendText(text string) error {
        b.writeMu.Lock()
        defer b.writeMu.Unlock()
        if time.Since(b.lastSay) < cmdRateInterval {
                time.Sleep(cmdRateInterval - time.Since(b.lastSay))
        }
        b.lastSay = time.Now()
        return b.conn.WritePacket(&packet.Text{
                TextType:   packet.TextTypeChat,
                SourceName: b.name,
                Message:    text,
        })
}

// sendCommand runs a command as the bot. PocketMine-MP only accepts
// CommandRequestPacket when the command line starts with "/", so add it.
func (b *Bot) sendCommand(line string) error {
        line = "/" + strings.TrimPrefix(strings.TrimSpace(line), "/")
        if len(line) < 2 {
                return nil
        }
        b.writeMu.Lock()
        defer b.writeMu.Unlock()
        if time.Since(b.lastSay) < cmdRateInterval {
                time.Sleep(cmdRateInterval - time.Since(b.lastSay))
        }
        b.lastSay = time.Now()
        return b.conn.WritePacket(&packet.CommandRequest{
                CommandLine: line,
                Internal:    false,
                CommandOrigin: protocol.CommandOrigin{
                        Origin:    protocol.CommandOriginPlayer,
                        UUID:      uuid.New(),
                        RequestID: "",
                },
        })
}

// close kicks the bot off the server exactly once.
func (b *Bot) close(reason string) {
        b.stopOnce.Do(func() {
                if b.conn != nil {
                        _ = b.conn.Close()
                }
                if b.state == "online" || b.state == "joining" {
                        b.setState("left", reason)
                }
        })
}

// readLoop drains the connection until the server closes it. Chat and command
// output the server sends to this bot are forwarded to the UI as chat events.
func (b *Bot) readLoop() {
        for {
                pk, err := b.conn.ReadPacket()
                if err != nil {
                        if b.state == "online" || b.state == "joining" {
                                b.setStateCode("left", "connection closed ("+shortErr(err)+")", classifyErr(err))
                        }
                        mgr.unsetListener(b)
                        return
                }
                if debug {
                        emit(map[string]any{"ev": "log", "text": fmt.Sprintf("%T", pk)})
                }
                switch p := pk.(type) {
                case *packet.Text:
                        b.emitText(p)
                case *packet.CommandOutput:
                        for _, m := range p.OutputMessages {
                                line := stripColor(m.Message)
                                if len(m.Parameters) > 0 {
                                        line += " " + strings.Join(m.Parameters, " ")
                                }
                                if strings.TrimSpace(line) != "" {
                                        emit(map[string]any{"ev": "chat", "name": b.name, "text": line})
                                }
                        }
                case *packet.Disconnect:
                        b.setStateCode("left", stripColor(p.Message), classifyDisconnect(stripColor(p.Message)))
                        mgr.unsetListener(b)
                        _ = b.conn.Close()
                        return
                }
        }
}

// emitText formats a server text packet into the UI chat stream. Only the
// designated listener bot forwards chat, otherwise every server broadcast
// would appear N times (once per bot).
func (b *Bot) emitText(p *packet.Text) {
        if !mgr.isListener(b) {
                return
        }
        params := make([]string, len(p.Parameters))
        for i, s := range p.Parameters {
                params[i] = stripColor(s)
        }
        text := stripColor(p.Message)

        switch p.TextType {
        case packet.TextTypeChat:
                if p.SourceName != "" && !strings.Contains(text, "<"+p.SourceName+">") {
                        text = "<" + p.SourceName + "> " + text
                }
        case packet.TextTypeTranslation, packet.TextTypeTip, packet.TextTypePopup, packet.TextTypeJukeboxPopup:
                text = translateKey(text, params)
        default:
                if len(params) > 0 {
                        text = translateKey(text, params)
                }
        }
        if strings.TrimSpace(text) == "" {
                return
        }
        emit(map[string]any{"ev": "chat", "name": b.name, "text": text})
}

// translateKey maps common Bedrock translation keys (which carry their content
// in parameters, not in the key itself) into readable text.
func translateKey(key string, params []string) string {
        p0, p1 := "", ""
        if len(params) > 0 {
                p0 = params[0]
        }
        if len(params) > 1 {
                p1 = params[1]
        }
        switch strings.TrimPrefix(key, "%") {
        case "chat.type.text":
                return "<" + p0 + "> " + p1
        case "chat.type.announcement":
                return "[" + p0 + "] " + p1
        case "multiplayer.player.joined":
                return "\u25b6 " + p0 + " joined"
        case "multiplayer.player.left":
                return "\u25c0 " + p0 + " left"
        case "multiplayer.player.joined.realms":
                return "\u25b6 " + p0 + " joined"
        case "disconnectionScreen.noReason", "disconnectionScreen.timeout":
                return key
        default:
                if len(params) > 0 {
                        return key + " [" + strings.Join(params, ", ") + "]"
                }
                return key
        }
}

// stripColor removes Minecraft \u00a7 formatting codes from a string.
func stripColor(s string) string {
        if !strings.ContainsRune(s, '\u00a7') {
                return s
        }
        var b strings.Builder
        runes := []rune(s)
        for i := 0; i < len(runes); i++ {
                if runes[i] == '\u00a7' && i+1 < len(runes) {
                        i++ // skip the format code character
                        continue
                }
                b.WriteRune(runes[i])
        }
        return b.String()
}

func shortErr(err error) string {
        s := err.Error()
        if len(s) > 240 {
                s = s[:240]
        }
        return strings.TrimSpace(s)
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

type Manager struct {
        mu       sync.Mutex
        bots     map[string]*Bot
        order    []string
        addr     string // current server target
        closing  bool
        listener *Bot // the bot whose chat view is forwarded to the UI
}

func NewManager() *Manager { return &Manager{bots: make(map[string]*Bot)} }

// isListener reports whether this bot is the designated chat forwarder.
func (m *Manager) isListener(b *Bot) bool {
        m.mu.Lock()
        defer m.mu.Unlock()
        return m.listener == b
}

// setListener makes this bot the chat forwarder if none is set.
func (m *Manager) setListener(b *Bot) {
        m.mu.Lock()
        defer m.mu.Unlock()
        if m.listener == nil {
                m.listener = b
        }
}

// unsetListener clears the forwarder if it was this bot and promotes the next
// online bot, keeping the UI log continuous.
func (m *Manager) unsetListener(b *Bot) {
        m.mu.Lock()
        if m.listener != b {
                m.mu.Unlock()
                return
        }
        m.listener = nil
        var next *Bot
        for _, n := range m.order {
                if cand := m.bots[n]; cand != nil && cand != b && cand.state == "online" {
                        next = cand
                        break
                }
        }
        m.listener = next
        m.mu.Unlock()
}

func (m *Manager) add(b *Bot) {
        m.mu.Lock()
        defer m.mu.Unlock()
        m.bots[b.name] = b
        m.order = append(m.order, b.name)
}

func (m *Manager) remove(name string) {
        m.mu.Lock()
        defer m.mu.Unlock()
        delete(m.bots, name)
        for i, n := range m.order {
                if n == name {
                        m.order = append(m.order[:i], m.order[i+1:]...)
                        break
                }
        }
}

func (m *Manager) count() int {
        m.mu.Lock()
        defer m.mu.Unlock()
        return len(m.bots)
}

// activeCount counts bots that occupy a slot on the server (online or joining).
func (m *Manager) activeCount() int {
        m.mu.Lock()
        defer m.mu.Unlock()
        n := 0
        for _, b := range m.bots {
                if b.state == "online" || b.state == "joining" {
                        n++
                }
        }
        return n
}

func (m *Manager) get(name string) *Bot {
        m.mu.Lock()
        defer m.mu.Unlock()
        return m.bots[name]
}

func (m *Manager) snapshot() []map[string]any {
        m.mu.Lock()
        defer m.mu.Unlock()
        out := make([]map[string]any, 0, len(m.order))
        for _, n := range m.order {
                b := m.bots[n]
                e := map[string]any{"name": b.name, "state": b.state, "msg": b.msg}
                if b.code != "" {
                        e["code"] = b.code
                }
                if b.gamertag != "" {
                        e["gamertag"] = b.gamertag
                }
                out = append(out, e)
        }
        return out
}

func (m *Manager) forEach(fn func(*Bot)) {
        m.mu.Lock()
        names := make([]string, len(m.order))
        copy(names, m.order)
        m.mu.Unlock()
        for _, n := range names {
                m.mu.Lock()
                b := m.bots[n]
                m.mu.Unlock()
                if b != nil {
                        fn(b)
                }
        }
}

// kick kicks one bot ("all" = every bot).
func (m *Manager) kick(name string) {
        if name == "all" {
                m.forEach(func(b *Bot) { b.close("kicked from panel") })
                emitLog("kicked all bots")
                return
        }
        if b := m.get(name); b != nil {
                b.close("kicked from panel")
                emitLog("kicked " + name)
        } else {
                emitLog("bot not found: " + name)
        }
}

// spawn dials every missing name and starts its read loop.
func (m *Manager) spawn(addr string, names []string, useAuth bool) {
        m.mu.Lock()
        current := m.addr
        m.mu.Unlock()
        if current != "" && current != addr && m.count() > 0 {
                emitLog("target changed " + current + " -> " + addr + "; kicking current bots")
                m.kick("all")
                time.Sleep(600 * time.Millisecond)
        }
        m.mu.Lock()
        m.addr = addr
        m.mu.Unlock()

        if useAuth {
                // one real account = one authenticated bot
                if len(names) > 1 {
                        emitLog("xbox auth: limiting batch to 1 bot (one account)")
                }
                names = names[:1]
        }

        // de-duplicate names; retry entries that are failed/left get replaced
        var fresh []string
        seen := map[string]bool{}
        for _, n := range names {
                if n == "" || seen[n] {
                        continue
                }
                if b := m.get(n); b != nil {
                        if b.state == "online" || b.state == "joining" {
                                continue // already there
                        }
                        m.remove(n) // replace stale failed/left entry
                }
                seen[n] = true
                fresh = append(fresh, n)
        }
        room := maxBots - m.activeCount()
        if len(fresh) > room {
                fresh = fresh[:room]
                emitLog(fmt.Sprintf("capped batch to %d bots (engine limit %d)", room, maxBots))
        }
        if len(fresh) == 0 {
                return
        }

        // preflight for remote targets: auto-detect the server's wire protocol
        // and pick the matching gophertunnel implementation (native or an older
        // version adapter) BEFORE spending a dial on it. Loopback targets skip
        // this - the bundled server always speaks the native protocol.
        remoteProto := int64(protocol.CurrentProtocol)
        srvVersion := ""
        if pf, checked := preflight(addr); checked && pf.proto > 0 {
                remoteProto = pf.proto
                srvVersion = pf.version
        }
        adapt, adaptVer, ok := protocolFor(remoteProto)
        if !ok {
                msg := fmt.Sprintf("server is MC %s (protocol %d) - engine supports: %s",
                        srvVersion, remoteProto, supportedVersionsText())
                if srvVersion == "" {
                        msg = fmt.Sprintf("server protocol %d is not supported - engine supports: %s",
                                remoteProto, supportedVersionsText())
                }
                emitLog("preflight " + addr + ": " + msg)
                for _, name := range fresh {
                        b := &Bot{name: name, addr: addr, state: "failed"}
                        m.add(b)
                        b.setStateCode("failed", msg, "version")
                }
                return
        }
        if adapt != nil {
                emitLog(fmt.Sprintf("preflight %s: server is MC %s (protocol %d) - dialing with matching protocol (%s)",
                        addr, srvVersion, remoteProto, adaptVer))
        }
        if !loopbackAddr(addr) {
                emitLog(fmt.Sprintf("joining %s (%s protocol %d) - %d bot(s), staggered %dms, %s per attempt",
                        addr, map[bool]string{true: "adapter " + adaptVer, false: "native"}[adapt != nil],
                        remoteProto, len(fresh), spawnStagger.Milliseconds(), dialTimeoutRemote))
        }

        go func() {
                for i, name := range fresh {
                        if m.activeCount() >= maxBots {
                                break
                        }
                        b := &Bot{name: name, addr: addr, state: "joining", key: genKey(), proto: adapt, protoVer: adaptVer}
                        m.add(b)
                        b.setState("joining", "connecting to "+addr)
                        go m.dial(b, useAuth)
                        if i < len(fresh)-1 {
                                time.Sleep(spawnStagger) // fixed, proven pacing (see v2.2.0 notes)
                        }
                }
        }()
}

// uiLogWriter pipes gophertunnel's internal error log into the UI join log.
// Without it, protocol/decode errors during the dial were silently discarded
// and the bot just hung until the deadline with no visible reason.
type uiLogWriter struct{}

func (uiLogWriter) Write(p []byte) (int, error) {
        s := strings.TrimSpace(strings.ReplaceAll(string(p), "\n", " "))
        if s != "" {
                emitLog("engine: " + s)
        }
        return len(p), nil
}

var engineErrorLog = slog.New(slog.NewTextHandler(uiLogWriter{}, &slog.HandlerOptions{Level: slog.LevelWarn}))

// retryableErr reports whether a second dial attempt can plausibly succeed.
// Version/full/banned/xbox/whitelist answers are definitive server verdicts;
// timeouts, refused connections and packet errors are transient conditions.
func retryableErr(err error) bool {
        switch classifyErr(err) {
        case "version", "full", "banned", "xbox", "whitelist", "edu":
                return false
        }
        return true
}

func (m *Manager) dial(b *Bot, useAuth bool) {
        budget := dialTimeoutLocal
        if !loopbackAddr(b.addr) {
                budget = dialTimeoutRemote
        }

        d := minecraft.Dialer{
                IdentityData: login.IdentityData{
                        Identity:    uuid.New().String(),
                        DisplayName: b.name,
                        // XUID intentionally empty -> offline (self-signed) login,
                        // accepted by servers with xbox-auth off. With an authenticated
                        // dial (TokenSource set) gophertunnel overwrites this with the
                        // data from the Mojang chain.
                },
                ClientData: clientDataFor(b),
                // TokenSource nil -> no Xbox Live authentication (offline mode).
                DisconnectOnUnknownPackets: false,
                DisconnectOnInvalidPackets: false,
                ErrorLog:                   engineErrorLog,
                // never let a foreign/stale pong redirect port move the dial
                // (the target was already pinged on exactly this address)
                DisablePortFollowing: preflightDisableFollowing(b.addr),
        }
        if b.proto != nil {
                // server runs an older Minecraft release: dial with the matching
                // wire adapter so the handshake speaks the server's protocol
                d.Protocol = b.proto
        }

        if useAuth {
                ctx, cancel := context.WithTimeout(context.Background(), dialTimeoutRemote)
                src, xbl, err := authMgr.dialAuth(ctx)
                cancel()
                if err != nil {
                        b.setStateCode("failed", "xbox sign-in: "+shortErr(err), "need_auth")
                        m.remove(b.name)
                        return
                }
                d.TokenSource = src
                d.XBLClient = xbl
        }

        // One extra attempt for transient failures: over a lossy WAN a single
        // handshake attempt regularly dies halfway (RakNet resend storm, a
        // dropped fragment of the big StartGame packet). A clean second try is
        // usually enough; definitive verdicts (version/full/banned/...) never
        // waste a retry.
        var conn *minecraft.Conn
        var lastErr error
        for attempt := 1; attempt <= 2; attempt++ {
                if attempt > 1 {
                        if retryableErr(lastErr) {
                                b.setState("joining", "retrying join after a failed attempt")
                                emitLog("join attempt for " + b.name + " failed (" + shortErr(lastErr) + ") - retrying once")
                                time.Sleep(1500 * time.Millisecond)
                        } else {
                                break
                        }
                }
                ctx, cancel := context.WithTimeout(context.Background(), budget)
                conn, lastErr = d.DialContext(ctx, "raknet", b.addr)
                cancel()
                if lastErr == nil {
                        break
                }
        }
        if lastErr != nil {
                /* v2.7: public servers with xbox-auth=on reject offline clients
                 * ("notAuthenticated"). When the user has signed in before, a
                 * saved session exists - silently redo the dial authenticated
                 * instead of failing with an error the user cannot fix. */
                if !useAuth && classifyErr(lastErr) == "xbox" && loadToken() != nil {
                        emitLog(b.name + ": server requires Xbox auth - retrying with the saved account")
                        actx, acancel := context.WithTimeout(context.Background(), 20*time.Second)
                        src, xbl, aerr := authMgr.dialAuth(actx)
                        acancel()
                        if aerr == nil {
                                d.TokenSource = src
                                d.XBLClient = xbl
                                rctx, rcancel := context.WithTimeout(context.Background(), budget)
                                conn, lastErr = d.DialContext(rctx, "raknet", b.addr)
                                rcancel()
                        }
                }
        }
        if lastErr != nil {
                code := classifyErr(lastErr)
                msg := shortErr(lastErr)
                if code == "version" {
                        msg += " (engine supports: " + supportedVersionsText() + ")"
                }
                b.setStateCode("failed", msg, code)
                m.remove(b.name)
                return
        }
        b.conn = conn
        if useAuth || b.gamertag != "" {
                b.gamertag = authMgr.currentGamertag()
                b.setState("online", "joined as "+b.gamertag)
        } else {
                b.setState("online", "joined the server")
        }
        mgr.setListener(b)
        go b.readLoop()
}

// shutdown kicks everyone and exits the process.
func (m *Manager) shutdown() {
        m.mu.Lock()
        if m.closing {
                m.mu.Unlock()
                return
        }
        m.closing = true
        m.mu.Unlock()
        m.forEach(func(b *Bot) { b.close("engine stopped") })
        time.Sleep(400 * time.Millisecond)
        emit(map[string]any{"ev": "bye"})
        os.Exit(0)
}

// ---------------------------------------------------------------------------
// ping (connection test / version probe)
// ---------------------------------------------------------------------------

func pingServer(addr string) {
        ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
        defer cancel()
        pong, err := raknet.Dialer{}.PingContext(ctx, addr)
        if err != nil {
                emit(map[string]any{"ev": "pong", "ok": false, "addr": addr, "error": shortErr(err)})
                return
        }
        frag := splitPong(string(pong))
        motd, sub := "", ""
        prot, version := "", ""
        players, maxp := "", ""
        if len(frag) > 1 {
                motd = frag[1]
        }
        if len(frag) > 2 {
                prot = frag[2]
        }
        if len(frag) > 3 {
                version = frag[3]
        }
        if len(frag) > 4 {
                players = frag[4]
        }
        if len(frag) > 5 {
                maxp = frag[5]
        }
        if len(frag) > 7 {
                sub = frag[7]
        }
        compat := ""
        if p, e := strconv.Atoi(strings.TrimSpace(prot)); e == nil {
                if isSupportedProto(int64(p)) {
                        compat = "ok" // native or covered by a wire adapter
                } else {
                        compat = "mismatch"
                }
        }
        emit(map[string]any{
                "ev": "pong", "ok": true, "addr": addr,
                "motd": motd, "submotd": sub, "protocol": prot, "version": version,
                "players": players, "max": maxp, "compat": compat,
        })
}

// ---------------------------------------------------------------------------
// preflight - one ping per target before dialing, so we fail fast with a clear
// reason instead of letting a doomed handshake time out, and so a stale pong
// redirect port cannot silently move the dial to a dead address.
// ---------------------------------------------------------------------------

type preflightInfo struct {
        at       time.Time
        proto    int64
        version  string
        redirect int64 // advertised IPv4 port from the pong (-1 when absent)
        redirectUp bool
}

var preCache sync.Map // addr -> preflightInfo

func loopbackAddr(addr string) bool {
        host := addr
        if i := strings.LastIndex(addr, ":"); i > 0 {
                host = addr[:i]
        }
        host = strings.Trim(host, "[]")
        return host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "0.0.0.0"
}

func portOf(addr string) int64 {
        if i := strings.LastIndex(addr, ":"); i > 0 {
                if p, e := strconv.ParseInt(addr[i+1:], 10, 32); e == nil {
                        return p
                }
        }
        return 19132
}

// preflight returns (info, checked). checked=false means "no reliable data"
// (loopback target, stale cache entry, or ping failed) and the dial proceeds
// exactly like before.
func preflight(addr string) (preflightInfo, bool) {
        if loopbackAddr(addr) {
                return preflightInfo{}, false
        }
        if v, ok := preCache.Load(addr); ok {
                if p, ok := v.(preflightInfo); ok && time.Since(p.at) < preflightTTL {
                        return p, true
                }
        }
        ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
        defer cancel()
        pong, err := raknet.Dialer{}.PingContext(ctx, addr)
        if err != nil {
                // cannot probe - dial as before (some servers block pongs)
                return preflightInfo{}, false
        }
        p := parsePong(string(pong))
        p.at = time.Now()
        if p.redirect > 0 && p.redirect != portOf(addr) {
                // the pong advertises a different IPv4 port: follow it only when
                // that port is genuinely reachable, otherwise it is a NAT artifact
                p.redirectUp = quickPing(hostOf(addr), p.redirect)
        }
        preCache.Store(addr, p)
        return p, true
}

func hostOf(addr string) string {
        if i := strings.LastIndex(addr, ":"); i > 0 {
                return addr[:i]
        }
        return addr
}

func quickPing(host string, port int64) bool {
        ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
        defer cancel()
        _, err := raknet.Dialer{}.PingContext(ctx, fmt.Sprintf("%s:%d", host, port))
        return err == nil
}

// preflightDisableFollowing reports whether the dialer must ignore the pong's
// redirect port (NAT-mapped servers where PMMP advertises its internal port).
func preflightDisableFollowing(addr string) bool {
        if loopbackAddr(addr) {
                return false
        }
        v, ok := preCache.Load(addr)
        if !ok {
                return false
        }
        p, ok := v.(preflightInfo)
        if !ok || p.redirect < 0 {
                return false
        }
        if p.redirect == 0 {
                return true
        }
        if p.redirect == portOf(addr) {
                return false
        }
        return !p.redirectUp
}

// parsePong extracts protocol, version string and the IPv4 redirect port from
// a RakNet pong (field 10, same index gophertunnel uses for port following).
func parsePong(s string) preflightInfo {
        p := preflightInfo{redirect: -1}
        frag := splitPong(s)
        if len(frag) > 2 {
                if v, e := strconv.ParseInt(strings.TrimSpace(frag[2]), 10, 32); e == nil {
                        p.proto = v
                }
        }
        if len(frag) > 3 {
                p.version = frag[3]
        }
        if len(frag) > 10 {
                if v, e := strconv.ParseInt(strings.TrimSpace(frag[10]), 10, 32); e == nil {
                        p.redirect = v
                }
        }
        return p
}

// ---------------------------------------------------------------------------
// resource pack fetcher ("getpacks") - joins a public Bedrock server like a
// real client, saves every resource pack the server would force onto the
// player, then disconnects. Files land in dest as "<Name> v<version>.mcpack";
// a packs-index.json sidecar lets repeat fetches skip packs already saved.
// ---------------------------------------------------------------------------

var (
        packMu     sync.Mutex
        packCancel context.CancelFunc // cancel for the fetch currently running
        packGen    int64              // generation counter (running fetch ids)
)

func emitPackEvent(phase string, extra map[string]any) {
        ev := map[string]any{"ev": "packs", "phase": phase}
        for k, v := range extra {
                ev[k] = v
        }
        emit(ev)
}

func packIndexKey(uuidStr, version string) string { return uuidStr + "|" + version }

func packIndexPath(dir string) string { return filepath.Join(dir, "packs-index.json") }

func loadPackIndex(dir string) map[string]string {
        m := map[string]string{}
        if b, err := os.ReadFile(packIndexPath(dir)); err == nil {
                _ = json.Unmarshal(b, &m)
        }
        return m
}

func savePackIndex(dir string, m map[string]string) {
        b, err := json.MarshalIndent(m, "", " ")
        if err != nil {
                return
        }
        _ = os.WriteFile(packIndexPath(dir), b, 0o644)
}

// sanitizePackName keeps a pack's manifest name usable as a file name:
// letters/digits/space/-_().  stay, everything else becomes a space, runs are
// collapsed and the result capped so long manifest names stay readable.
func sanitizePackName(s string) string {
        var b strings.Builder
        for _, r := range s {
                switch {
                case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
                        r == ' ', r == '-', r == '_', r == '(', r == ')', r == '.', r == '\'':
                        b.WriteRune(r)
                default:
                        b.WriteRune(' ')
                }
        }
        out := strings.Join(strings.Fields(b.String()), " ")
        runes := []rune(out)
        if len(runes) > 48 {
                out = strings.TrimSpace(string(runes[:48]))
        }
        return out
}

// packStore implements minecraft.ResourcePackCache: gophertunnel hands over
// every fully downloaded, checksum-verified pack here; we write it to disk
// under a friendly name and record it in the index sidecar.
type packStore struct {
        dir   string
        index map[string]string
        mu    sync.Mutex
}

// Load always misses on purpose: the "already have this pack" short-circuit
// happens in the DownloadResourcePack hook (it can tell the server we have
// it, which Load cannot).
func (s *packStore) Load(ctx context.Context, key minecraft.ResourcePackCacheKey) (*resource.Pack, error) {
        return nil, nil
}

func (s *packStore) Store(ctx context.Context, key minecraft.ResourcePackCacheKey, pack *resource.Pack) error {
        s.mu.Lock()
        defer s.mu.Unlock()
        if err := os.MkdirAll(s.dir, 0o755); err != nil {
                return err
        }
        keyStr := packIndexKey(key.UUID.String(), key.Version)
        name := s.index[keyStr]
        if name == "" {
                base := sanitizePackName(pack.Name() + " v" + key.Version)
                if base == "" {
                        base = "pack " + key.UUID.String()[:8] + " v" + key.Version
                }
                candidate := base + ".mcpack"
                if _, err := os.Stat(filepath.Join(s.dir, candidate)); err == nil {
                        // name taken on disk: reuse only if this exact pack owns it,
                        // otherwise disambiguate with the pack UUID prefix
                        owned := false
                        for k, v := range s.index {
                                if v == candidate && k == keyStr {
                                        owned = true
                                        break
                                }
                        }
                        if !owned {
                                candidate = fmt.Sprintf("%s [%s].mcpack", base, key.UUID.String()[:8])
                        }
                }
                name = candidate
        }
        target := filepath.Join(s.dir, name)
        tmp, err := os.CreateTemp(s.dir, "pack-*.tmp")
        if err != nil {
                return err
        }
        tmpName := tmp.Name()
        _, copyErr := io.Copy(tmp, io.NewSectionReader(pack, 0, int64(pack.Len())))
        closeErr := tmp.Close()
        if copyErr != nil || closeErr != nil {
                _ = os.Remove(tmpName)
                if copyErr != nil {
                        return copyErr
                }
                return closeErr
        }
        if err := os.Rename(tmpName, target); err != nil {
                _ = os.Remove(tmpName)
                return err
        }
        _ = os.Chmod(target, 0o644) // CreateTemp defaults to 0600; keep packs world-readable like other downloads
        s.index[keyStr] = name
        savePackIndex(s.dir, s.index)
        emitPackEvent("packdone", map[string]any{"file": name, "size": pack.Len()})
        return nil
}

// packFileList lists every .mcpack in dir for the final "done" event.
// The list is capped: stdout event lines are bounded, and a server with more
// than 30 packs would be absurd - the files are all on disk regardless.
func packFileList(dir string) []map[string]any {
        entries := []map[string]any{}
        files, err := os.ReadDir(dir)
        if err != nil {
                return entries
        }
        for _, f := range files {
                if len(entries) >= 30 {
                        break
                }
                if f.IsDir() {
                        continue
                }
                if !strings.HasSuffix(strings.ToLower(f.Name()), ".mcpack") {
                        continue
                }
                info, err := f.Info()
                if err != nil {
                        continue
                }
                entries = append(entries, map[string]any{
                        "file": f.Name(),
                        "name": strings.TrimSuffix(f.Name(), ".mcpack"),
                        "size": info.Size(),
                })
        }
        sort.Slice(entries, func(i, j int) bool {
                return entries[i]["file"].(string) < entries[j]["file"].(string)
        })
        return entries
}

func emitPackError(err error) {
        emitPackEvent("error", map[string]any{"error": shortErr(err), "code": classifyErr(err)})
}

// fetchPacks connects to addr and saves its resource packs into dest.
func fetchPacks(addr, dest string, useAuth bool) {
        packMu.Lock()
        if packCancel != nil {
                packCancel() // a previous fetch is still running: stop it first
        }
        myGen := atomic.AddInt64(&packGen, 1)
        rootCtx, rootCancel := context.WithCancel(context.Background())
        packCancel = rootCancel
        packMu.Unlock()
        defer func() {
                rootCancel()
                if atomic.LoadInt64(&packGen) == myGen {
                        packMu.Lock()
                        if atomic.LoadInt64(&packGen) == myGen {
                                packCancel = nil
                        }
                        packMu.Unlock()
                }
        }()

        if err := os.MkdirAll(dest, 0o755); err != nil {
                emitPackError(fmt.Errorf("cannot create destination dir: %w", err))
                return
        }
        emitPackEvent("started", map[string]any{"addr": addr, "dest": dest})
        index := loadPackIndex(dest)

        // packs can be tens of MB over a phone network: give the whole
        // handshake+download a generous budget (loopback finishes in seconds)
        budget := 480 * time.Second
        if loopbackAddr(addr) {
                budget = 90 * time.Second
        }
        ctx, cancel := context.WithTimeout(rootCtx, budget)
        defer cancel()

        // same protocol detection as the bots: public servers run older Minecraft
        // releases all the time, so dial with the matching wire adapter
        remoteProto := int64(protocol.CurrentProtocol)
        srvVersion := ""
        if pf, checked := preflight(addr); checked && pf.proto > 0 {
                remoteProto = pf.proto
                srvVersion = pf.version
        }
        adapt, _, ok := protocolFor(remoteProto)
        if !ok {
                emitPackEvent("error", map[string]any{
                        "error": fmt.Sprintf("server is MC %s (protocol %d) - engine supports: %s",
                                srvVersion, remoteProto, supportedVersionsText()),
                        "code": "version",
                })
                return
        }

        fetchBot := &Bot{name: "PackFetcher", protoVer: ""}
        if adapt != nil {
                fetchBot.protoVer = adapt.Ver()
        }
        d := minecraft.Dialer{
                IdentityData: login.IdentityData{
                        Identity:    uuid.New().String(),
                        DisplayName: fetchBot.name,
                },
                ClientData:                 clientDataFor(fetchBot),
                DisconnectOnUnknownPackets: false,
                DisconnectOnInvalidPackets: false,
                ErrorLog:                   engineErrorLog,
                DisablePortFollowing:       preflightDisableFollowing(addr),
                ResourcePackCache:          &packStore{dir: dest, index: index},
        }
        if adapt != nil {
                d.Protocol = adapt
        }

        // decide per advertised pack: skip the ones already saved on disk
        // (the server accepts it like a returning player) and announce the rest
        d.DownloadResourcePack = func(id uuid.UUID, version string, current, total int) bool {
                select {
                case <-rootCtx.Done():
                        return false
                default:
                }
                if f, ok := index[packIndexKey(id.String(), version)]; ok && f != "" {
                        if st, err := os.Stat(filepath.Join(dest, f)); err == nil && st.Size() > 0 {
                                emitPackEvent("cached", map[string]any{
                                        "file": f, "i": current + 1, "total": total,
                                })
                                return false
                        }
                }
                emitPackEvent("downloading", map[string]any{
                        "i": current + 1, "total": total,
                })
                return true
        }

        // byte-level progress: ResourcePackChunkData frames stream through here
        var chunkBytes int64
        var lastProgress time.Time
        d.PacketFunc = func(header packet.Header, payload []byte, src, dst net.Addr) {
                if header.PacketID != packet.IDResourcePackChunkData {
                        return
                }
                atomic.AddInt64(&chunkBytes, int64(len(payload)))
                if time.Since(lastProgress) >= 700*time.Millisecond {
                        lastProgress = time.Now()
                        emitPackEvent("progress", map[string]any{"bytes": atomic.LoadInt64(&chunkBytes)})
                }
        }

        if useAuth {
                src, xbl, err := authMgr.dialAuth(ctx)
                if err != nil {
                        emitPackError(fmt.Errorf("xbox sign-in: %w", err))
                        return
                }
                d.TokenSource = src
                d.XBLClient = xbl
        }

        emitLog("pack fetch: joining " + addr + " (" +
                map[bool]string{true: "adapter", false: "native"}[adapt != nil] + ")")
        conn, err := d.DialContext(ctx, "raknet", addr)
        if err != nil {
                /* v2.7: server demands Xbox auth and we have a saved session -
                 * silently retry the join authenticated. */
                if !useAuth && classifyErr(err) == "xbox" && loadToken() != nil {
                        emitLog("pack fetch: server requires Xbox auth - retrying with the saved account")
                        actx, acancel := context.WithTimeout(context.Background(), 20*time.Second)
                        src, xbl, aerr := authMgr.dialAuth(actx)
                        acancel()
                        if aerr == nil {
                                d.TokenSource = src
                                d.XBLClient = xbl
                                rctx, rcancel := context.WithTimeout(context.Background(), 240*time.Second)
                                conn, err = d.DialContext(rctx, "raknet", addr)
                                rcancel()
                        }
                }
        }
        if err != nil {
                if rootCtx.Err() != nil {
                        emitPackEvent("error", map[string]any{"error": "cancelled", "code": "cancelled"})
                        return
                }
                emitPackError(err)
                return
        }
        // the packs are already on disk at this point - no need to actually spawn
        _ = conn.Close()
        emitPackEvent("done", map[string]any{"addr": addr, "packs": packFileList(dest)})
}

// ---------------------------------------------------------------------------
// failure classification - lets the UI show a helpful localized message
// ---------------------------------------------------------------------------

func classifyErr(err error) string {
        if err == nil {
                return ""
        }
        var de minecraft.DisconnectError
        if errors.As(err, &de) {
                return classifyDisconnect(string(de))
        }
        s := strings.ToLower(err.Error())
        switch {
        case strings.Contains(s, "outdated"):
                return "version"
        case strings.Contains(s, "incompatible") || strings.Contains(s, "bad packet") || strings.Contains(s, "invalid packet"):
                return "incompatible"
        case strings.Contains(s, "server full"):
                return "full"
        case strings.Contains(s, "deadline"), strings.Contains(s, "timeout"), strings.Contains(s, "timed out"):
                return "timeout"
        case strings.Contains(s, "refused"), strings.Contains(s, "unreachable"), strings.Contains(s, "no route"), strings.Contains(s, "reset"):
                return "refused"
        case strings.Contains(s, "xbox"), strings.Contains(s, "auth"), strings.Contains(s, "account"), strings.Contains(s, "signed in"), strings.Contains(s, "session"), strings.Contains(s, "certificate"), strings.Contains(s, "chain"):
                return "xbox"
        case strings.Contains(s, "banned"):
                return "banned"
        case strings.Contains(s, "whitelist"), strings.Contains(s, "white-list"):
                return "whitelist"
        case strings.Contains(s, "edu"):
                return "edu"
        }
        return "error"
}

// classifyDisconnect maps a server Disconnect reason to a UI failure class.
func classifyDisconnect(reason string) string {
        s := strings.ToLower(reason)
        switch {
        case strings.Contains(s, "xbox"), strings.Contains(s, "authenticated"), strings.Contains(s, "authentication"), strings.Contains(s, "account"), strings.Contains(s, "sign in"), strings.Contains(s, "signed"), strings.Contains(s, "invalid session"), strings.Contains(s, "invalid token"), strings.Contains(s, "log in"):
                return "xbox"
        case strings.Contains(s, "banned"), strings.Contains(s, "you are banned"), strings.Contains(s, "ban:"):
                return "banned"
        case strings.Contains(s, "white"):
                return "whitelist"
        case strings.Contains(s, "full"):
                return "full"
        case strings.Contains(s, "outdated"), strings.Contains(s, "version"):
                return "version"
        case strings.Contains(s, "timeout"), strings.Contains(s, "timed out"), strings.Contains(s, "timeout:"):
                return "timeout"
        case strings.Contains(s, "endstream"), strings.Contains(s, "internal server error"), strings.Contains(s, "server error"):
                return "server"
        }
        return "server"
}

func splitPong(s string) []string {
        var runes []rune
        var tokens []string
        inEscape := false
        for _, r := range s {
                switch {
                case r == '\\':
                        inEscape = true
                case r == ';':
                        tokens = append(tokens, string(runes))
                        runes = runes[:0]
                case inEscape:
                        inEscape = false
                        fallthrough
                default:
                        runes = append(runes, r)
                }
        }
        return append(tokens, string(runes))
}

// ---------------------------------------------------------------------------
// skin: give every bot a unique, human-looking 64x64 skin so the world does
// not fill up with identical placeholder characters.
// ---------------------------------------------------------------------------

func clientDataFor(b *Bot) login.ClientData {
        // Steady per-bot RNG seed so re-spawns look the same for a given name.
        rng := rand.New(rand.NewSource(int64(hashName(b.name))))
        w, h := 64, 64
        pix := make([]byte, w*h*4)

        skinTones := [][4]byte{
                {246, 216, 181, 255}, {224, 178, 134, 255}, {166, 124, 82, 255},
                {132, 92, 60, 255}, {92, 62, 40, 255}, {255, 227, 198, 255},
        }
        shirt := [4]byte{byte(rng.Intn(220) + 25), byte(rng.Intn(220) + 25), byte(rng.Intn(220) + 25), 255}
        pants := [4]byte{byte(rng.Intn(90) + 20), byte(rng.Intn(90) + 20), byte(rng.Intn(120) + 30), 255}
        shoe := [4]byte{60, 44, 34, 255}
        face := skinTones[rng.Intn(len(skinTones))]
        hair := [4]byte{byte(rng.Intn(60) + 10), byte(rng.Intn(45) + 8), byte(rng.Intn(35) + 5), 255}

        for y := 0; y < h; y++ {
                for x := 0; x < w; x++ {
                        var c [4]byte
                        switch {
                        case y >= 56:
                                c = shoe
                        case y >= 36:
                                c = pants
                        case y >= 20:
                                c = shirt
                        case y < 8:
                                c = hair
                        case y < 16:
                                c = face
                        case y == 17 && (x >= 24 && x <= 28 || x >= 35 && x <= 39):
                                c = hair // eyes row accent
                        default:
                                c = face
                        }
                        if rng.Intn(12) == 0 { // subtle noise so skins do not look flat
                                c[0] = clamp255(int(c[0]) + rng.Intn(13) - 6)
                                c[1] = clamp255(int(c[1]) + rng.Intn(13) - 6)
                                c[2] = clamp255(int(c[2]) + rng.Intn(13) - 6)
                        }
                        off := (y*w + x) * 4
                        pix[off], pix[off+1], pix[off+2], pix[off+3] = c[0], c[1], c[2], c[3]
                }
        }
        return login.ClientData{
                SkinID:           uuid.New().String(),
                SkinData:         base64.StdEncoding.EncodeToString(pix),
                SkinImageWidth:   w,
                SkinImageHeight:  h,
                DeviceModel:      "PMPanel Bot",
                LanguageCode:     "en_GB",
                DeviceOS:         protocol.DeviceAndroid,
                GameVersion:      b.gameVersion(),
                CurrentInputMode: packet.InputModeTouch,
                DefaultInputMode: packet.InputModeTouch,
        }
}

// gameVersion is the version string the client JWT advertises: matching the
// dialed protocol keeps old servers happy when they check ClientData.
func (b *Bot) gameVersion() string {
        if b.protoVer != "" {
                return b.protoVer
        }
        return protocol.CurrentVersion
}

func clamp255(v int) byte {
        if v < 0 {
                return 0
        }
        if v > 255 {
                return 255
        }
        return byte(v)
}

func hashName(s string) uint32 {
        var h uint32 = 2166136261
        for i := 0; i < len(s); i++ {
                h ^= uint32(s[i])
                h *= 16777619
        }
        return h
}

func genKey() *ecdsa.PrivateKey {
        k, err := ecdsa.GenerateKey(elliptic.P521(), cryptorand.Reader)
        if err != nil {
                panic(err)
        }
        return k
}

// ---------------------------------------------------------------------------
// Xbox Live auth - optional REAL Microsoft account sign-in (device code, the
// same XAL flow the official Android Bedrock client uses). Bots joined this way
// carry a genuine auth chain (XUID + gamertag) and are accepted by servers with
// xbox-auth enabled. One account = one authenticated bot.
// ---------------------------------------------------------------------------

type AuthManager struct {
        mu       sync.Mutex
        state    string // none | signing | code | ok
        code     string
        url      string
        gamertag string
        xuid     string
        cancel   context.CancelFunc
        src      oauth2.TokenSource
        xbl      *xsapi.Client
}

var authMgr = &AuthManager{state: "none"}

var reAuthLine = regexp.MustCompile(`Authenticate at (\S+)\s+using the code\s+(\S+)`)

func tokenPath() string {
        home := os.Getenv("HOME")
        if home == "" {
                home = os.TempDir()
        }
        return filepath.Join(home, "pm_bot_xbox_token.json")
}

func loadToken() *oauth2.Token {
        b, err := os.ReadFile(tokenPath())
        if err != nil || len(b) == 0 {
                return nil
        }
        var t oauth2.Token
        if json.Unmarshal(b, &t) != nil || t.RefreshToken == "" {
                return nil
        }
        return &t
}

func saveToken(t *oauth2.Token) {
        b, err := json.Marshal(t)
        if err != nil {
                return
        }
        _ = os.WriteFile(tokenPath(), b, 0600)
}

func clearTokenFile() { _ = os.Remove(tokenPath()) }

// authWriter captures the "Authenticate at <url> using the code <code>" line
// the device-code flow prints and turns it into a UI event.
type authWriter struct{}

func (authWriter) Write(p []byte) (int, error) {
        if m := reAuthLine.FindStringSubmatch(string(p)); m != nil {
                authMgr.setCode(m[2], m[1])
        }
        return len(p), nil
}

// cachedTokenSource resolves tokens from the on-disk cache, refreshing them
// automatically; when the refresh token has gone stale it transparently
// restarts the interactive device-code flow.
type cachedTokenSource struct{}

func (cachedTokenSource) Token() (*oauth2.Token, error) { return authMgr.token() }

func (am *AuthManager) token() (*oauth2.Token, error) {
        am.mu.Lock()
        src := am.src
        am.mu.Unlock()
        if src == nil {
                t := loadToken()
                if t == nil {
                        t, err := am.deviceFlow()
                        if err != nil {
                                return nil, err
                        }
                        am.mu.Lock()
                        am.src = auth.AndroidConfig.RefreshTokenSourceWriter(t, authWriter{})
                        am.mu.Unlock()
                        am.emitOK()
                        return t, nil
                }
                am.mu.Lock()
                am.src = auth.AndroidConfig.RefreshTokenSourceWriter(t, authWriter{})
                src = am.src
                am.mu.Unlock()
        }
        tok, err := src.Token()
        if err != nil {
                // cached refresh token is dead: wipe and redo the device flow once
                clearTokenFile()
                am.mu.Lock()
                am.src = nil
                am.mu.Unlock()
                t, err2 := am.deviceFlow()
                if err2 != nil {
                        return nil, err2
                }
                am.mu.Lock()
                am.src = auth.AndroidConfig.RefreshTokenSourceWriter(t, authWriter{})
                am.mu.Unlock()
                am.emitOK()
                return t, nil
        }
        return tok, nil
}

// deviceFlow runs the interactive device-code sign-in (blocks until the user
// finishes in the browser or the flow is cancelled).
func (am *AuthManager) deviceFlow() (*oauth2.Token, error) {
        ctx, cancel := context.WithCancel(context.Background())
        am.mu.Lock()
        am.cancel = cancel
        am.state = "signing"
        am.mu.Unlock()
        emit(map[string]any{"ev": "auth", "state": "signing"})
        t, err := auth.AndroidConfig.RequestLiveTokenContext(ctx, authWriter{})
        am.mu.Lock()
        am.cancel = nil
        am.mu.Unlock()
        if err != nil {
                if ctx.Err() == context.Canceled {
                        am.mu.Lock()
                        am.state = "none"
                        am.mu.Unlock()
                        emit(map[string]any{"ev": "auth", "state": "none"})
                        return nil, errors.New("cancelled")
                }
                am.mu.Lock()
                am.state = "none"
                am.mu.Unlock()
                emit(map[string]any{"ev": "auth", "state": "error", "error": shortErr(err)})
                return nil, err
        }
        saveToken(t)
        return t, nil
}

func (am *AuthManager) setCode(code, url string) {
        am.mu.Lock()
        am.state, am.code, am.url = "code", code, url
        am.mu.Unlock()
        emit(map[string]any{"ev": "auth", "state": "code", "code": code, "url": url})
}

func (am *AuthManager) emitOK() {
        am.mu.Lock()
        am.state = "ok"
        gt, xuid := am.gamertag, am.xuid
        am.mu.Unlock()
        if gt != "" {
                emit(map[string]any{"ev": "auth", "state": "ok", "gamertag": gt, "xuid": xuid})
        }
}

func (am *AuthManager) currentGamertag() string {
        am.mu.Lock()
        defer am.mu.Unlock()
        return am.gamertag
}

// xblFor builds (once) the Xbox Live client used for authenticated dials and
// reads the gamertag from the XSTS token.
func (am *AuthManager) xblFor(ctx context.Context) (*xsapi.Client, error) {
        am.mu.Lock()
        xbl := am.xbl
        am.mu.Unlock()
        if xbl != nil {
                return xbl, nil
        }
        ctx = auth.WithContextClient(ctx, http.DefaultClient)
        sess := auth.ContextSession(ctx, cachedTokenSource{})
        xbl, err := xsapi.ClientConfig{RTAMode: xsapi.RTADisabled}.New(ctx, sess)
        if err != nil {
                return nil, err
        }
        ui := xbl.UserInfo()
        am.mu.Lock()
        am.xbl = xbl
        am.gamertag = ui.GamerTag
        am.xuid = ui.XUID
        am.state = "ok"
        gt, xuid := am.gamertag, am.xuid
        am.mu.Unlock()
        emit(map[string]any{"ev": "auth", "state": "ok", "gamertag": gt, "xuid": xuid})
        return xbl, nil
}

// dialAuth resolves the token + XBL client for an authenticated dial.
func (am *AuthManager) dialAuth(ctx context.Context) (oauth2.TokenSource, *xsapi.Client, error) {
        if _, err := (cachedTokenSource{}).Token(); err != nil {
                return nil, nil, err
        }
        xbl, err := am.xblFor(ctx)
        if err != nil {
                return nil, nil, err
        }
        return cachedTokenSource{}, xbl, nil
}

func (am *AuthManager) emitState() {
        am.mu.Lock()
        defer am.mu.Unlock()
        ev := map[string]any{"ev": "auth", "state": am.state}
        if am.code != "" {
                ev["code"] = am.code
        }
        if am.url != "" {
                ev["url"] = am.url
        }
        if am.gamertag != "" {
                ev["gamertag"] = am.gamertag
        }
        emit(ev)
}

func (am *AuthManager) start() {
        // Token(): cached+refresh or interactive device flow; xblFor validates the
        // account against XBL and emits the gamertag.
        if _, err := (cachedTokenSource{}).Token(); err != nil {
                return // failure already emitted
        }
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()
        if _, err := am.xblFor(ctx); err != nil {
                emit(map[string]any{"ev": "auth", "state": "error", "error": shortErr(err)})
        }
}

// quietValidate restores a saved session in the background when the engine
// boots: refresh the stored token and read the gamertag. Failures stay silent
// (no interactive flow is started from here).
func (am *AuthManager) quietValidate() {
        t := loadToken()
        if t == nil {
                return
        }
        src := auth.AndroidConfig.RefreshTokenSourceWriter(t, authWriter{})
        if _, err := src.Token(); err != nil {
                return // stale/offline - stays "none" until an explicit sign-in
        }
        am.mu.Lock()
        am.src = src
        am.mu.Unlock()
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()
        _, _ = am.xblFor(ctx) // emits ok + gamertag on success
}

func (am *AuthManager) cancelFlow() {
        am.mu.Lock()
        c := am.cancel
        am.mu.Unlock()
        if c != nil {
                c()
        }
}

func (am *AuthManager) logout() {
        am.mu.Lock()
        am.state, am.code, am.url, am.gamertag, am.xuid = "none", "", "", "", ""
        am.src = nil
        c := am.cancel
        am.cancel = nil
        xbl := am.xbl
        am.xbl = nil
        am.mu.Unlock()
        if c != nil {
                c()
        }
        if xbl != nil {
                _ = xbl.Close()
        }
        clearTokenFile()
        emit(map[string]any{"ev": "auth", "state": "none"})
}

// ---------------------------------------------------------------------------
// input handling
// ---------------------------------------------------------------------------

type op struct {
        Op      string   `json:"op"`
        Addr    string   `json:"addr,omitempty"`
        Names   []string `json:"names,omitempty"`
        To      string   `json:"to,omitempty"`
        Text    string   `json:"text,omitempty"`
        UseAuth bool     `json:"useAuth,omitempty"`
        Dest    string   `json:"dest,omitempty"`
}

func normalizeAddr(addr string) string {
        addr = strings.TrimSpace(addr)
        if addr == "" {
                return ""
        }
        if !strings.Contains(addr, ":") {
                addr += ":19132"
        }
        return addr
}

func main() {
        // gophertunnel logs connection errors to stderr by default; keep stderr
        // quiet so the app never mistakes it for data (we only read stdout).
        emit(map[string]any{"ev": "ready", "engine": engineVersion,
                "protocol": protocol.CurrentProtocol, "version": protocol.CurrentVersion,
                "packs": true, "supported": supportedVersionsText()})

        sigc := make(chan os.Signal, 2)
        signal.Notify(sigc, syscall.SIGINT, syscall.SIGTERM)
        go func() {
                <-sigc
                mgr.shutdown()
        }()

        // restore a saved Xbox session (if any) quietly in the background
        go authMgr.quietValidate()

        sc := bufio.NewScanner(os.Stdin)
        sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
        for sc.Scan() {
                line := strings.TrimSpace(sc.Text())
                if line == "" {
                        continue
                }
                var o op
                if err := json.Unmarshal([]byte(line), &o); err != nil {
                        emitLog("bad op: " + shortErr(err))
                        continue
                }
                switch o.Op {
                case "ping":
                        addr := normalizeAddr(o.Addr)
                        if addr == "" {
                                emit(map[string]any{"ev": "pong", "ok": false, "error": "no address"})
                                continue
                        }
                        go pingServer(addr)
                case "getpacks":
                        addr := normalizeAddr(o.Addr)
                        if addr == "" {
                                emitPackEvent("error", map[string]any{"error": "no address", "code": "error"})
                                continue
                        }
                        if o.Dest == "" {
                                emitPackEvent("error", map[string]any{"error": "no destination", "code": "error"})
                                continue
                        }
                        go fetchPacks(addr, o.Dest, o.UseAuth)
                case "packs_stop":
                        packMu.Lock()
                        c := packCancel
                        packMu.Unlock()
                        if c != nil {
                                c()
                                emitLog("pack fetch cancelled")
                        }
                case "spawn":
                        addr := normalizeAddr(o.Addr)
                        if addr == "" {
                                emitLog("spawn: no address given")
                                continue
                        }
                        if len(o.Names) == 0 {
                                emitLog("spawn: no names given")
                                continue
                        }
                        mgr.spawn(addr, o.Names, o.UseAuth)
                case "auth_state":
                        authMgr.emitState()
                case "auth_start":
                        go authMgr.start()
                case "auth_cancel":
                        authMgr.cancelFlow()
                case "auth_logout":
                        authMgr.logout()
                case "say":
                        if o.Text == "" {
                                continue
                        }
                        if o.To == "all" || o.To == "" {
                                mgr.forEach(func(b *Bot) {
                                        if b.state == "online" {
                                                go func(bot *Bot, t string) {
                                                        if err := bot.sendText(t); err != nil {
                                                                bot.setState("failed", shortErr(err))
                                                        }
                                                }(b, o.Text)
                                        }
                                })
                        } else if b := mgr.get(o.To); b != nil {
                                if err := b.sendText(o.Text); err != nil {
                                        b.setState("failed", shortErr(err))
                                }
                        } else {
                                emitLog("bot not found: " + o.To)
                        }
                case "cmd":
                        if o.Text == "" {
                                continue
                        }
                        if o.To == "all" || o.To == "" {
                                mgr.forEach(func(b *Bot) {
                                        if b.state == "online" {
                                                go func(bot *Bot, t string) {
                                                        if err := bot.sendCommand(t); err != nil {
                                                                bot.setState("failed", shortErr(err))
                                                        }
                                                }(b, o.Text)
                                        }
                                })
                        } else if b := mgr.get(o.To); b != nil {
                                if err := b.sendCommand(o.Text); err != nil {
                                        b.setState("failed", shortErr(err))
                                }
                        } else {
                                emitLog("bot not found: " + o.To)
                        }
                case "kick":
                        mgr.kick(o.To)
                case "list":
                        emit(map[string]any{"ev": "bots", "list": mgr.snapshot()})
                case "stop":
                        mgr.shutdown()
                default:
                        emitLog("unknown op: " + o.Op)
                }
        }
        // stdin closed -> parent died; clean up so no bots leak on the server.
        mgr.shutdown()
}


