<?php
/**
 * PMPanel plugin compiler / decompiler.
 *
 * Usage (run with the bundled static PHP):
 *   php pmtools.php compile   <sourceFolder> <outPhar>
 *   php pmtools.php decompile <phar> <outFolder>
 *
 * Prints exactly one JSON result line prefixed with __PMTOOLS__ so the
 * Android side can safely locate it even if PHP notices leak to stdout.
 */

error_reporting(E_ALL);

function out(bool $ok, array $data = [], string $error = ''): void {
    $payload = array_merge(['ok' => $ok], $ok ? $data : ['error' => $error]);
    echo "__PMTOOLS__" . json_encode($payload) . "\n";
    exit($ok ? 0 : 1);
}

function countFiles(string $dir): int {
    $n = 0;
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS)
    );
    foreach ($it as $f) { $n++; }
    return $n;
}

if ($argc < 4) {
    out(false, [], "usage: pmtools.php compile <src> <out> | decompile <phar> <outDir>");
}

$mode = strtolower($argv[1]);
$src = $argv[2];
$dst = $argv[3];

try {
    if ($mode === 'compile') {
        if (!is_dir($src)) out(false, [], "source folder not found: $src");
        if (!is_file($src . '/plugin.yml')) {
            out(false, [], "plugin.yml not found in the source folder root");
        }
        if (is_file($dst)) {
            @unlink($dst);
        }

        $pharPath = $dst;
        $phar = new Phar($pharPath, 0, basename($dst));
        $phar->startBuffering();
        $phar->buildFromDirectory(realpath($src));
        // PocketMine reads plugin.yml from the archive root; ensure a proper
        // executable stub + signature (the server runs phar.require_hash=1).
        $phar->setStub('<?php __HALT_COMPILER();');
        $phar->setSignatureAlgorithm(Phar::SHA256);
        $phar->setMetadata(['createdBy' => 'PMPanel']);
        $phar->stopBuffering();

        out(true, [
            'files' => countFiles($src),
            'size' => filesize($pharPath),
            'out' => $pharPath,
        ]);
    } elseif ($mode === 'decompile') {
        if (!is_file($src)) out(false, [], "phar not found: $src");
        if (is_dir($dst)) {
            out(false, [], "output folder already exists: $dst");
        }
        @mkdir($dst, 0775, true);

        $phar = new Phar($src);
        $n = 0;
        foreach (new RecursiveIteratorIterator($phar) as $file) {
            $n++;
        }
        $phar->extractTo($dst, null, true);
        out(true, ['files' => $n, 'out' => $dst]);
    } else {
        out(false, [], "unknown mode: $mode");
    }
} catch (Throwable $e) {
    out(false, [], get_class($e) . ': ' . $e->getMessage());
}
