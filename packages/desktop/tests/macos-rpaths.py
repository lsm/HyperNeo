import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

DESKTOP = Path(__file__).resolve().parents[1]
CHECKER = DESKTOP / 'check-macos-rpaths.py'


class MacRuntimePaths(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='desktop-runtime-')
        self.addCleanup(self.directory.cleanup)
        self.app = Path(self.directory.name) / 'Fixture.app'
        self.macos = self.app / 'Contents/MacOS'
        self.macos.mkdir(parents=True)
        self.source = Path(self.directory.name) / 'fixture.c'
        self.source.write_text('int fixture(void) { return 0; }\n')
        self.library = self.macos / 'libfixture.dylib'
        self.compile('-dynamiclib', str(self.source), '-install_name',
                     '@rpath/libfixture.dylib', '-o', str(self.library))
        self.source.write_text('extern int fixture(void); int main(void) { return fixture(); }\n')

    def compile(self, *args):
        subprocess.run(['/usr/bin/clang', *args], check=True, capture_output=True)

    def executable(self, *rpaths):
        flags = [flag for path in rpaths for flag in ('-Wl,-rpath,' + path,)]
        self.compile(str(self.source), str(self.library), *flags,
                     '-o', str(self.macos / 'fixture'))

    def check(self, code):
        result = subprocess.run([sys.executable, str(CHECKER), str(self.app)],
                                capture_output=True, text=True)
        print(result.stdout + result.stderr, end='')
        print(f'checker exit={result.returncode}, expected={code}')
        self.assertEqual(result.returncode, code)
        self.assertIn('Mach-O files', result.stdout)
        return result.stdout + result.stderr

    def test_refuses_missing_runtime_path(self):
        self.executable()
        self.assertIn('unresolved @rpath/libfixture.dylib', self.check(1))

    def test_resolves_loader_path(self):
        self.executable('@loader_path')
        self.check(0)

    def test_resolves_executable_path(self):
        self.executable('@executable_path')
        self.check(0)

    def test_resolves_absolute_path_after_missing_candidate(self):
        self.executable('/missing-fixture-directory', str(self.macos))
        self.check(0)

    def test_refuses_missing_dependency(self):
        self.executable('@loader_path')
        self.library.unlink()
        self.check(1)

    def test_checks_nested_macho(self):
        self.executable('@loader_path')
        nested = self.app / 'Contents/Resources'
        nested.mkdir()
        self.library.rename(nested / self.library.name)
        self.check(1)

    def test_refuses_empty_bundle(self):
        self.library.unlink()
        self.assertIn('Checked 0 Mach-O files', self.check(1))

    def test_requires_macos_13(self):
        config = json.loads((DESKTOP / 'src-tauri/tauri.conf.json').read_text())
        self.assertEqual(config['bundle']['macOS']['minimumSystemVersion'], '13.0')

    def test_links_system_swift_for_macos_binaries(self):
        build = (DESKTOP / 'src-tauri/build.rs').read_text()
        self.assertIn('CARGO_CFG_TARGET_OS', build)
        self.assertIn('cargo:rustc-link-arg-bins=-Wl,-rpath,/usr/lib/swift', build)


if __name__ == '__main__':
    unittest.main(verbosity=2)
