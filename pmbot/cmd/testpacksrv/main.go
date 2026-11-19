// testpacksrv - local Bedrock listener that offers resource packs, so the
// engine's "getpacks" op can be tested end-to-end without internet.
//
// Usage: testpacksrv <port> <packPath>...
package main

import (
        "context"
        "fmt"
        "log/slog"
        "os"
        "os/signal"
        "syscall"
        "time"

        "github.com/go-gl/mathgl/mgl32"
        "github.com/sandertv/gophertunnel/minecraft"
        "github.com/sandertv/gophertunnel/minecraft/protocol"
        "github.com/sandertv/gophertunnel/minecraft/protocol/packet"
        "github.com/sandertv/gophertunnel/minecraft/resource"
)

func main() {
        if len(os.Args) < 3 {
                fmt.Println("usage: testpacksrv <port> <packPath>...")
                os.Exit(2)
        }
        var packs []*resource.Pack
        for _, p := range os.Args[2:] {
                pk, err := resource.ReadPath(p)
                if err != nil {
                        fmt.Println("PACK-ERR", p, err)
                        os.Exit(1)
                }
                packs = append(packs, pk)
                fmt.Printf("PACK %s v%s (%d bytes)\n", pk.Name(), pk.Version(), pk.Len())
        }

        cfg := minecraft.ListenConfig{
                ErrorLog:               slog.New(slog.NewTextHandler(os.Stderr, nil)),
                ResourcePacks:          packs,
                DisableEducationPacks:  true,
                AuthenticationDisabled: true,
        }
        l, err := cfg.Listen("raknet", fmt.Sprintf("0.0.0.0:%s", os.Args[1]))
        if err != nil {
                fmt.Println("LISTEN-ERR", err)
                os.Exit(1)
        }
        fmt.Println("READY", os.Args[1])
        go func() {
                for {
                        conn, err := l.Accept()
                        if err != nil {
                                return
                        }
                        go handleConn(conn.(*minecraft.Conn))
                }
        }()

        sigc := make(chan os.Signal, 2)
        signal.Notify(sigc, syscall.SIGINT, syscall.SIGTERM)
        <-sigc
        _ = l.Close()
}

func handleConn(conn *minecraft.Conn) {
        name := conn.IdentityData().DisplayName
        fmt.Println("SPAWN", name)
        defer conn.Close()
        gd := minecraft.GameData{
                EntityUniqueID:  1,
                EntityRuntimeID: 1,
                PlayerGameMode:  packet.GameTypeSurvival,
                PlayerPosition:  mgl32.Vec3{0, 64, 0},
                WorldSpawn:      protocol.BlockPos{0, 64, 0},
                WorldName:       "PackTest",
                Difficulty:      1,
                Time:            1000,
                Dimension:       0,
        }
        ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
        defer cancel()
        if err := conn.StartGameContext(ctx, gd); err != nil {
                fmt.Println("SPAWN_FAIL", name, err)
                return
        }
        for {
                if _, err := conn.ReadPacket(); err != nil {
                        fmt.Println("CLOSED", name)
                        return
                }
        }
}
