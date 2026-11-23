"""Install the checksum-pinned promtool used by this drill into a local directory."""
import argparse
import hashlib
import os
from pathlib import Path
import platform
import shutil
import tarfile
from tempfile import TemporaryDirectory
from urllib.request import urlopen
import zipfile

VERSION = "3.16.0"
RELEASES = {
    "Windows": ("windows-amd64", "zip", "89c03c2f24400fb58668440b6d7226f68564acda27d657e77acfbda42be32cb3"),
    "Linux": ("linux-amd64", "tar.gz", "68727009472a2c02e1ff7f062fd5b3e637285bffc8fc2d340c76fb449d6e0f34"),
}


def install(destination):
    if platform.machine().lower() not in {"amd64", "x86_64"} or platform.system() not in RELEASES:
        raise ValueError("Use an installed promtool on this platform")
    target, suffix, digest = RELEASES[platform.system()]
    prefix = f"prometheus-{VERSION}.{target}"
    archive = f"{prefix}.{suffix}"
    name = "promtool.exe" if suffix == "zip" else "promtool"
    destination.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=destination) as temp:
        path = Path(temp) / archive
        url = f"https://github.com/prometheus/prometheus/releases/download/v{VERSION}/{archive}"
        with urlopen(url, timeout=120) as remote, path.open("wb") as local:
            shutil.copyfileobj(remote, local)
        with path.open("rb") as local:
            if hashlib.file_digest(local, "sha256").hexdigest() != digest:
                raise ValueError("Release digest mismatch")
        staged = Path(temp) / name
        with staged.open("wb") as out:
            if suffix == "zip":
                with zipfile.ZipFile(path) as bundle, bundle.open(f"{prefix}/{name}") as stream:
                    shutil.copyfileobj(stream, out)
            else:
                with tarfile.open(path) as bundle, bundle.extractfile(f"{prefix}/{name}") as stream:
                    shutil.copyfileobj(stream, out)
        staged.chmod(0o755)
        os.replace(staged, destination / name)
    return destination / name


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    print(install(parser.parse_args().directory))
