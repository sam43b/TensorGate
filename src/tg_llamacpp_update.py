import os
import re
import shutil
import stat
import tarfile
import tempfile
from pathlib import Path

import requests

DEFAULT_DESTINATION_PATH = Path("/home/sam/appz/llama_cpp/build/bin")
GITHUB_API = "https://api.github.com/repos/ggerganov/llama.cpp/releases/latest"
ASSET_PATTERN = re.compile(r"llama-.*?-bin-ubuntu-vulkan-x64\.tar\.gz", re.I)


def resolve_destination_path(env_file_path=None):
    path = os.environ.get("LLAMA_CPP_PATH", "")
    if env_file_path and os.path.exists(env_file_path):
        try:
            with open(env_file_path, "r") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("#") or "=" not in line:
                        continue
                    key, value = line.split("=", 1)
                    if key.strip() == "LLAMA_CPP_PATH":
                        path = value.strip().strip('"').strip("'")
                        break
        except Exception:
            pass
    if path:
        p = Path(path)
        if p.name.lower() == "llama-server":
            return p.parent
    return DEFAULT_DESTINATION_PATH


def get_latest_asset_url():
    r = requests.get(GITHUB_API, timeout=30)
    r.raise_for_status()
    assets = r.json().get("assets", [])
    for asset in assets:
        if ASSET_PATTERN.search(asset["name"]):
            return asset["browser_download_url"]
    raise RuntimeError("No Ubuntu-Vulkan binary found in the latest release.")


def remove_old_build(dest):
    if dest.exists():
        shutil.rmtree(dest)


def download_and_extract(url, dest, log_callback=None, progress_callback=None):
    archive_name = url.split("/")[-1]
    tmp_archive = Path.cwd() / archive_name

    if log_callback:
        log_callback(f"Downloading {url} ...")

    with requests.get(url, stream=True, timeout=30) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        downloaded = 0
        with open(tmp_archive, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
                downloaded += len(chunk)
                if total and progress_callback:
                    progress_callback(min(int(downloaded * 80 / total), 80))

    if log_callback:
        log_callback("Download complete.")

    with tempfile.TemporaryDirectory() as tmp_extract_dir:
        if log_callback:
            log_callback("Extracting archive safely...")

        with tarfile.open(tmp_archive, "r:gz") as tf:
            tf.extractall(tmp_extract_dir, filter="data")

        extracted_path = Path(tmp_extract_dir)
        source_bin_dir = None

        for p in extracted_path.rglob("bin"):
            if p.is_dir():
                source_bin_dir = p
                break

        if not source_bin_dir:
            source_bin_dir = next(extracted_path.iterdir()) if any(extracted_path.iterdir()) else extracted_path

        dest.mkdir(parents=True, exist_ok=True)
        if log_callback:
            log_callback(f"Moving binaries to {dest} ...")
        if progress_callback:
            progress_callback(85)

        for item in source_bin_dir.iterdir():
            target_item = dest / item.name
            if item.is_dir():
                shutil.copytree(item, target_item, dirs_exist_ok=True)
            else:
                shutil.copy2(item, target_item)

    if log_callback:
        log_callback("Updating file permissions...")
    if progress_callback:
        progress_callback(90)

    for root, _, files in os.walk(dest):
        for fname in files:
            fpath = Path(root) / fname
            if fpath.suffix.lower() not in {".so", ".dll", ".txt", ".md"}:
                fpath.chmod(fpath.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    if log_callback:
        log_callback("Permissions updated.")
    if progress_callback:
        progress_callback(100)

    tmp_archive.unlink(missing_ok=True)


def run_update(log_callback=None, progress_callback=None, env_file_path=None):
    dest = resolve_destination_path(env_file_path)
    url = get_latest_asset_url()
    if log_callback:
        log_callback(f"Latest asset URL: {url}")
        log_callback(f"Target directory: {dest}")
    remove_old_build(dest)
    download_and_extract(url, dest, log_callback=log_callback, progress_callback=progress_callback)
    return f"Update finished. Binaries are ready in: {dest}"
