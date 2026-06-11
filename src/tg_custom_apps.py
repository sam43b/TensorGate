# process_mgmt.py - Process management for LLM, Embedding, Reranker servers and Custom Apps
import subprocess
import signal
import time
import os
import logging
from src.tg_log_manager import custom_apps_log_buffers, custom_apps_log_queues
from src.tg_config import CUSTOM_APPS_ENV_FILE, PRESETS_FILE

logger = logging.getLogger(__name__)

# Global process references
llm_process = None
embedding_process = None
reranker_process = None
custom_apps_processes = {}  # {app_name: process}

def stop_custom_app_internal(app_id):
    """Internal function to stop a custom app"""
    global custom_apps_processes

    if app_id not in custom_apps_processes or not custom_apps_processes[app_id]:
        return {"status": "App is not running!", "success": False}

    process = custom_apps_processes[app_id]

    try:
        # Try graceful termination first
        os.killpg(os.getpgid(process.pid), signal.SIGTERM)

        # Wait a bit for graceful shutdown
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            # Force kill if necessary
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            process.wait()

        custom_apps_processes[app_id] = None

        # Log the stop
        timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
        stop_msg = f"[{timestamp}] APP STOPPED: {app_id}"
        if app_id in custom_apps_log_buffers:
            custom_apps_log_buffers[app_id].append(stop_msg)
        if app_id in custom_apps_log_queues:
            custom_apps_log_queues[app_id].put(stop_msg)

        return {"status": f"App '{app_id}' stopped successfully!", "success": True}

    except Exception as e:
        logger.error(f"Error stopping app {app_id}: {e}")
        return {"status": f"Error stopping app: {str(e)}", "success": False}

def ensure_directories():
    """Ensure required directories exist"""
    os.makedirs(os.path.dirname(CUSTOM_APPS_ENV_FILE), exist_ok=True)
    if not os.path.exists(CUSTOM_APPS_ENV_FILE):
        with open(CUSTOM_APPS_ENV_FILE, 'w') as f:
            f.write("""# Custom Apps Configuration
# Format: DISPLAY_NAME=PATH|DESCRIPTION
# Example: MY_APP=/path/to/run.sh|My Application

""")

def parse_custom_apps_env():
    """Parse custom apps from environment file"""
    apps = []

    if not os.path.exists(CUSTOM_APPS_ENV_FILE):
        ensure_directories()
        return apps

    try:
        with open(CUSTOM_APPS_ENV_FILE, 'r') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line or line.startswith('#'):
                    continue

                if '=' not in line:
                    continue

                try:
                    name, value = line.split('=', 1)
                    name = name.strip()

                    if '|' in value:
                        path, description = value.rsplit('|', 1)
                    else:
                        path = value
                        description = name.replace('_', ' ').title()

                    path = path.strip()
                    description = description.strip()

                    if path and name:
                        apps.append({
                            'id': name,
                            'name': name,
                            'display_name': description,
                            'path': path,
                            'exists': os.path.exists(path),
                            'line_num': line_num
                        })
                except ValueError:
                    continue

    except Exception as e:
        pass

    return apps

def save_custom_app(name, path, description):
    """Add or update a custom app in the env file"""
    ensure_directories()

    apps = parse_custom_apps_env()

    # Check if app already exists
    existing = next((app for app in apps if app['id'] == name), None)

    lines = []
    if os.path.exists(CUSTOM_APPS_ENV_FILE):
        with open(CUSTOM_APPS_ENV_FILE, 'r') as f:
            lines = f.readlines()

    new_line = f"{name}={path}|{description}\n"

    if existing:
        # Update existing line
        for i, line in enumerate(lines):
            if line.strip().startswith(f"{name}="):
                lines[i] = new_line
                break
    else:
        # Append new line
        lines.append(new_line)

    with open(CUSTOM_APPS_ENV_FILE, 'w') as f:
        f.writelines(lines)

    return True

def remove_custom_app(name):
    """Remove a custom app from the env file"""
    if not os.path.exists(CUSTOM_APPS_ENV_FILE):
        return False

    with open(CUSTOM_APPS_ENV_FILE, 'r') as f:
        lines = f.readlines()

    lines = [line for line in lines if not line.strip().startswith(f"{name}=")]

    with open(CUSTOM_APPS_ENV_FILE, 'w') as f:
        f.writelines(lines)

    return True

def load_presets():
    """Load preset configurations from file"""
    presets = {}

    if not os.path.exists(PRESETS_FILE):
        # Create default presets file if it doesn't exist
        default_presets = """# presets.cfg
# Format: name|temperature|top_p|top_k|min_p|presence_penalty|repetition_penalty|description

default|0.8|0.95|40|0.0|0.0|1.0|⛩️ Default for general tasks • temp=0.8 • top_p=0.95
creative|1.0|0.95|20|0.0|1.5|1.0|🎨 High creativity mode • temp=1.0 • top_p=0.95
coding|0.6|0.95|20|0.0|0.0|1.0|💻 Precise coding mode • temp=0.6 • presence_penalty=0.0
instruct_general|0.7|0.8|20|0.0|1.5|1.0|📋 Balanced instruct mode • temp=0.7 • top_p=0.8
instruct_reasoning|1.0|1.0|40|0.0|2.0|1.0|🧠 High reasoning capability • temp=1.0 • top_p=1.0 • presence=2.0
"""
        try:
            with open(PRESETS_FILE, 'w') as f:
                f.write(default_presets)
        except Exception as e:
            pass

    try:
        with open(PRESETS_FILE, 'r') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line or line.startswith('#'):
                    continue

                parts = line.split('|')
                if len(parts) >= 8:
                    try:
                        name = parts[0].strip()
                        presets[name] = {
                            'temperature': float(parts[1]),
                            'top_p': float(parts[2]),
                            'top_k': int(parts[3]),
                            'min_p': float(parts[4]),
                            'presence_penalty': float(parts[5]),
                            'repetition_penalty': float(parts[6]),
                            'description': parts[7].strip()
                        }
                    except (ValueError, IndexError):
                        pass
                else:
                    pass

    except Exception as e:
        pass

    return presets
