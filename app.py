# app.py - Main Flask application
import os
import subprocess
import signal
import atexit
import logging
import time
import json
import queue
import threading
from flask import Flask, render_template, request, jsonify, make_response

# Import modules from src package
from src.tg_config import (
    CUSTOM_APPS_ENV_FILE, MODEL_DIR, EMBEDDING_MODEL_DIR,
    RERANKER_MODEL_DIR, LLAMA_CPP_PATH, CACHE_DIR,
    CONTEXT_OPTIONS, KV_CACHE_OPTIONS, POOLING_OPTIONS
)

# Project directory - hardcoded since it's the app's own base directory
PROJECT_DIR = os.path.expanduser(os.getenv("PROJECT_DIR" ,"~/llama"))
from src.tg_settings import get_env_variables, update_env_variable, delete_env_variable
from src.tg_models import get_models, get_embedding_models, get_reranker_models
from src.tg_system_stats import get_system_stats
from src.tg_custom_apps import (
    parse_custom_apps_env, save_custom_app, remove_custom_app, load_presets, ensure_directories,
    llm_process, embedding_process, reranker_process,
    custom_apps_processes, stop_custom_app_internal
)
from src.tg_log_manager import (
    llm_log_buffer, embedding_log_buffer, reranker_log_buffer,
    llm_log_queue, embedding_log_queue, reranker_log_queue,
    custom_apps_log_buffers, custom_apps_log_queues, prompt_progress,
    log_reader, get_generation_state,
    update_binaries_log_buffer, update_binaries_log_queue, update_binaries_progress
)

# Set up logging
logging.basicConfig(level=logging.DEBUG,
                    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app_tf = 'public'

app = Flask(__name__, template_folder=app_tf, static_folder=app_tf + '/' + 'static')

#################################
#### Cleanup and startup ####
#################################

def cleanup():
    global llm_process, embedding_process, reranker_process, custom_apps_processes
    logger.info("Cleaning up before exit...")

    if llm_process:
        try:
            os.killpg(os.getpgid(llm_process.pid), signal.SIGTERM)
        except:
            pass

    if embedding_process:
        try:
            os.killpg(os.getpgid(embedding_process.pid), signal.SIGTERM)
        except:
            pass

    if reranker_process:
        try:
            os.killpg(os.getpgid(reranker_process.pid), signal.SIGTERM)
        except:
            pass

    # Cleanup custom apps
    for app_id, process in custom_apps_processes.items():
        if process:
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGTERM)
            except:
                pass

    subprocess.run(["rm", "-rf", CACHE_DIR], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    subprocess.run(["pkill", "-f", "llama-server"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

atexit.register(cleanup)

#################################
#### ROUTES ####
#################################

@app.route("/")
def index():
    llm_models, mmproj_models = get_models()
    embedding_models = get_embedding_models()
    reranker_models = get_reranker_models()
    custom_apps = parse_custom_apps_env()
    presets = load_presets()
    return render_template("index.html",
                         models=llm_models,
                         mmproj_models=mmproj_models,
                         context_options=CONTEXT_OPTIONS,
                         kv_cache_options=KV_CACHE_OPTIONS,
                         embedding_models=embedding_models,
                         reranker_models=reranker_models,
                         pooling_options=POOLING_OPTIONS,
                         custom_apps=custom_apps,
                         presets=presets)

@app.route("/system")
def system_stats():
    return jsonify(get_system_stats())

@app.route("/prompt-progress")
def get_prompt_progress():
    """Return current prompt processing progress"""
    return jsonify({
        "progress": prompt_progress["value"],
        "active": prompt_progress["active"],
        "status": "processing" if prompt_progress["active"] else "idle",
        "generation_state": get_generation_state()
    })

@app.route("/presets")
def get_presets():
    """API endpoint to get presets as JSON"""
    return jsonify(load_presets())

@app.route("/logs")
def get_logs():
    """Return LLM logs"""
    entries = []
    try:
        while not llm_log_queue.empty():
            entries.append({"text": llm_log_queue.get_nowait()})
    except Exception as e:
        logger.error(f"Error getting logs: {e}")
    return jsonify({"entries": entries, "reset": False})

@app.route("/logs/buffer")
def get_logs_buffer():
    """Return LLM logs from buffer (non-consuming)"""
    entries = []
    try:
        entries = [{"text": log_entry} for log_entry in list(llm_log_buffer)]
    except Exception as e:
        logger.error(f"Error getting logs from buffer: {e}")
    return jsonify({"entries": entries, "reset": False})

@app.route("/embedding/logs")
def get_embedding_logs():
    """Return embedding logs"""
    entries = []
    try:
        while not embedding_log_queue.empty():
            entries.append({"text": embedding_log_queue.get_nowait()})
    except Exception as e:
        logger.error(f"Error getting embedding logs: {e}")
    return jsonify({"entries": entries, "reset": False})

@app.route("/embedding/logs/buffer")
def get_embedding_logs_buffer():
    """Return embedding logs from buffer (non-consuming)"""
    entries = []
    try:
        entries = [{"text": log_entry} for log_entry in list(embedding_log_buffer)]
    except Exception as e:
        logger.error(f"Error getting embedding logs from buffer: {e}")
    return jsonify({"entries": entries, "reset": False})

@app.route("/reranker/logs")
def get_reranker_logs():
    """Return reranker logs"""
    entries = []
    try:
        while not reranker_log_queue.empty():
            entries.append({"text": reranker_log_queue.get_nowait()})
    except Exception as e:
        logger.error(f"Error getting reranker logs: {e}")
    return jsonify({"entries": entries, "reset": False})

@app.route("/reranker/logs/buffer")
def get_reranker_logs_buffer():
    """Return reranker logs from buffer (non-consuming)"""
    entries = []
    try:
        entries = [{"text": log_entry} for log_entry in list(reranker_log_buffer)]
    except Exception as e:
        logger.error(f"Error getting reranker logs from buffer: {e}")
    return jsonify({"entries": entries, "reset": False})

# Custom Apps Routes
@app.route("/custom-apps")
def get_custom_apps():
    """Get list of custom apps"""
    apps = parse_custom_apps_env()
    # Add running status
    for app in apps:
        app['running'] = app['id'] in custom_apps_processes and custom_apps_processes[app['id']] is not None
    return jsonify(apps)

@app.route("/custom-apps/save", methods=["POST"])
def save_custom_app_route():
    """Save a new custom app"""
    try:
        name = request.form.get("name", "").strip().upper().replace(" ", "_")
        path = request.form.get("path", "").strip()
        description = request.form.get("description", "").strip()

        if not name or not path:
            return jsonify({"status": "Name and path are required!", "success": False})

        if not os.path.exists(path):
            return jsonify({"status": f"Path does not exist: {path}", "success": False})

        save_custom_app(name, path, description or name)
        return jsonify({"status": f"Custom app '{name}' saved successfully!", "success": True})
    except Exception as e:
        logger.exception(f"Error saving custom app: {e}")
        return jsonify({"status": f"Error: {str(e)}", "success": False})

@app.route("/custom-apps/delete", methods=["POST"])
def delete_custom_app_route():
    """Delete a custom app"""
    try:
        name = request.form.get("name", "").strip()
        if not name:
            return jsonify({"status": "App name is required!", "success": False})

        # Stop if running
        if name in custom_apps_processes and custom_apps_processes[name]:
            stop_custom_app_internal(name)

        remove_custom_app(name)
        return jsonify({"status": f"Custom app '{name}' deleted!", "success": True})
    except Exception as e:
        logger.exception(f"Error deleting custom app: {e}")
        return jsonify({"status": f"Error: {str(e)}", "success": False})

@app.route("/custom-apps/start", methods=["POST"])
def start_custom_app():
    """Start a custom app"""
    try:
        app_id = request.form.get("app_id")
        if not app_id:
            return jsonify({"status": "No app ID provided!", "success": False})

        # Check if already running
        if app_id in custom_apps_processes and custom_apps_processes[app_id]:
            return jsonify({"status": "App is already running!", "success": False})

        apps = parse_custom_apps_env()
        app_config = next((a for a in apps if a['id'] == app_id), None)

        if not app_config:
            return jsonify({"status": "App not found in configuration!", "success": False})

        if not os.path.exists(app_config['path']):
            return jsonify({"status": f"Executable not found: {app_config['path']}", "success": False})

        # Initialize log buffer and queue for this app
        custom_apps_log_buffers[app_id] = deque(maxlen=1000)
        custom_apps_log_queues[app_id] = queue.Queue()

        # Prepare command
        app_path = app_config['path']
        env = os.environ.copy()

        # Determine if it's a script that needs shell execution
        is_script = app_path.endswith(('.sh', '.bash', '.zsh'))

        if is_script:
            command = f"bash {app_path}"
        else:
            command = app_path

        # Clear logs
        custom_apps_log_buffers[app_id].clear()
        while not custom_apps_log_queues[app_id].empty():
            custom_apps_log_queues[app_id].get()

        timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
        start_msg = f"[{timestamp}] STARTING CUSTOM APP: {app_config['display_name']}"
        custom_apps_log_buffers[app_id].append(start_msg)
        custom_apps_log_queues[app_id].put(start_msg)

        # Start process
        if is_script:
            process = subprocess.Popen(
                command,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                preexec_fn=os.setsid,
                env=env,
                bufsize=1,
                universal_newlines=False
            )
        else:
            process = subprocess.Popen(
                [app_path],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                preexec_fn=os.setsid,
                env=env,
                bufsize=1,
                universal_newlines=False
            )

        custom_apps_processes[app_id] = process

        # Start log reader
        log_reader(process, custom_apps_log_buffers[app_id], custom_apps_log_queues[app_id], app_id)

        time.sleep(1)

        if process.poll() is not None:
            exit_code = process.poll()
            error_msg = f"Process exited immediately with code {exit_code}"
            timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
            log_msg = f"[{timestamp}] CRITICAL ERROR: {error_msg}"
            custom_apps_log_buffers[app_id].append(log_msg)
            custom_apps_log_queues[app_id].put(log_msg)
            custom_apps_processes[app_id] = None
            return jsonify({"status": f"Error: {error_msg}", "success": False})

        return jsonify({
            "status": f"Custom app '{app_config['display_name']}' started!",
            "success": True
        })

    except Exception as e:
        logger.exception(f"Error starting custom app: {e}")
        return jsonify({"status": f"Error: {str(e)}", "success": False})

@app.route("/custom-apps/stop", methods=["POST"])
def stop_custom_app():
    """Stop a custom app"""
    try:
        app_id = request.form.get("app_id")
        if not app_id:
            return jsonify({"status": "No app ID provided!", "success": False})

        result = stop_custom_app_internal(app_id)
        return jsonify(result)

    except Exception as e:
        logger.exception(f"Error stopping custom app: {e}")
        return jsonify({"status": f"Error: {str(e)}", "success": False})

#################################
#### LLM Server Routes ####
#################################

@app.route("/start", methods=["POST"])
def start_llm_server():
    global llm_process
    if llm_process:
        return jsonify({"status": "LLM Model is already running!", "success": False})

    try:
        model = request.form.get("model")
        if not model:
            return jsonify({"status": "No model selected!", "success": False})

        threads = request.form.get("threads", "8")
        port = request.form.get("port", os.getenv("LLM_DEFAULT_PORT", "8080"))
        host = request.form.get("host", "0.0.0.0")
        ngl = request.form.get("ngl", "22")
        context_key = request.form.get("c", "8k")
        c = CONTEXT_OPTIONS.get(context_key, 8192)
        sm = request.form.get("sm", "layer")
        np = request.form.get("np", "1")

        temperature = request.form.get("temperature", "1.0")
        top_p = request.form.get("top_p", "0.95")
        top_k = request.form.get("top_k", "20")
        min_p = request.form.get("min_p", "0.0")
        presence_penalty = request.form.get("presence_penalty", "1.5")
        repetition_penalty = request.form.get("repetition_penalty", "1.0")
        cache_type_k = request.form.get("cache_type_k", "q8_0")
        cache_type_v = request.form.get("cache_type_v", "q8_0")

        swa_full = request.form.get("swa-full", None)
        flash_attn = request.form.get("flash-attn", None)
        thinking_off = request.form.get("thinking-off", None)
        vision_off = request.form.get("vision-off", None)

        models_data, mmproj_models = get_models()
        mmproj_path = mmproj_models.get(model)

        display_name = os.path.basename(model).replace('.gguf', '')
        if mmproj_path:
            display_name += " - vision"

        env = os.environ.copy()
        model_full_path = os.path.join(MODEL_DIR, model)

        """"
         -b (Batch Size): The logical maximum batch size. Higher numbers improve Prompt Processing (PP) speeds. Good values to test: 512, 1024, 2048, 4096.
         -ub (uBatch/Physical Size): The physical maximum batch size. Increasing this can drastically speed up processing, especially on Apple Silicon. Good values to test: 128, 512, 1024, 2048

         Macs (M2/M3/M4): Setting -b 2048 and -ub 2048 generally yields high prompt processing speeds.
         Nvidia (12GB+ VRAM): Setting -ub to 512 or 1024 with -b 2048 balances VRAM overflow.

        """
        command_parts = [
             f"{LLAMA_CPP_PATH}",
            f"-m {model_full_path}",
            f"--threads {threads}",
            f"--port {port}",
            f"--host {host}",
            f"--n-gpu-layers {ngl}",
            f"--ctx-size {c}",
            f"-sm {sm}",
            f"--parallel {np}",
            f"--temp {temperature}",
            f"--top-p {top_p}",
            f"--top-k {top_k}",
            f"--min-p {min_p}",
            f"--presence-penalty {presence_penalty}",
            f"--repeat-penalty {repetition_penalty}",
            f"--cache-type-k {cache_type_k}",
            f"--cache-type-v {cache_type_v}"
        ]


        command_parts.append(os.getenv("LLM_DEFAULT_Flags" ,"--batch-size 2048 --ubatch-size 512 --cache-reuse 256 --mlock --no-mmap --jinja -cram -1 --threads-http 2 --reasoning-budget 0 --fit on"))     
            

        if mmproj_path:
            if not vision_off:
                mmproj_full_path = os.path.join(MODEL_DIR, mmproj_path)
                command_parts.append(f"--mmproj {mmproj_full_path}")

        if swa_full == "on":
            command_parts.append("--swa-full")

        if '-MTP-' in model or '-qat-' in model:
            #--spec-type ngram-mod --spec-ngram-mod-n-match 24 --spec-ngram-mod-n-min 48 --spec-ngram-mod-n-max 64
            #--spec-type ngram-mod --spec-ngram-mod-n-max 64
            #--spec-type draft-mtp --spec-draft-n-max 3 
            command_parts.append(os.getenv("LLM_DEFAULT_MTP" ,"--spec-type draft-mtp --spec-draft-n-max 3"))

        if flash_attn == "on":
            command_parts.append("--flash-attn on")

        if thinking_off == "on":
            command_parts.append("--reasoning off")

        command = " ".join(command_parts)

        # Clear logs
        llm_log_buffer.clear()
        while not llm_log_queue.empty():
            llm_log_queue.get()

        timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
        start_msg = f"[{timestamp}] STARTING LLM: {display_name} on {host}:{port} , with command : {command}"
        llm_log_buffer.append(start_msg)
        llm_log_queue.put(start_msg)

        llm_process = subprocess.Popen(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            preexec_fn=os.setsid,
            env=env,
            bufsize=1,
            universal_newlines=False
        )

        # Reset prompt processing progress tracking for new session
        prompt_progress["value"] = 0.0
        prompt_progress["active"] = False

        log_reader(llm_process, llm_log_buffer, llm_log_queue, "LLM")

        time.sleep(1)

        if llm_process.poll() is not None:
            exit_code = llm_process.poll()
            error_msg = f"Process exited immediately with code {exit_code}"
            timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
            log_msg = f"[{timestamp}] CRITICAL ERROR: {error_msg}"
            llm_log_buffer.append(log_msg)
            llm_log_queue.put(log_msg)
            llm_process = None
            return jsonify({"status": f"Error: {error_msg}", "success": False})

        return jsonify({"status": f"LLM '{display_name}' started on {host}:{port}", "success": True})

    except Exception as e:
        logger.exception(f"Error starting LLM: {e}")
        return jsonify({"status": f"Error: {str(e)}", "success": False})

@app.route("/stop", methods=["POST"])
def stop_llm_server():
    global llm_process

    if llm_process:
        try:
            os.killpg(os.getpgid(llm_process.pid), signal.SIGTERM)
        except:
            pass
        llm_process = None

    try:
        subprocess.run(["pkill", "-f", f"{LLAMA_CPP_PATH}.*-m.*\\.gguf"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except:
        pass

    return jsonify({"status": "LLM server stopped!", "success": True})

#################################
#### Embedding Server Routes ####
#################################

@app.route("/embedding/start", methods=["POST"])
def start_embedding_server():
    global embedding_process
    if embedding_process:
        return jsonify({"status": "Embedding model is already running!", "success": False})

    try:
        model = request.form.get("embedding_model")
        if not model:
            return jsonify({"status": "No embedding model selected!", "success": False})

        port = request.form.get("embedding_port", os.getenv("EMBEDDING_DEFAULT_PORT", "8081"))
        host = request.form.get("embedding_host", "0.0.0.0")
        threads = request.form.get("embedding_threads", "2")
        ubatch_size = request.form.get("ubatch_size", "8192")
        pooling = request.form.get("pooling", "last")
        ngl = request.form.get("embedding_ngl", "0")

        model_full_path = os.path.join(MODEL_DIR, model)
        display_name = os.path.basename(model).replace('.gguf', '')

        env = os.environ.copy()

        command_parts = [
            f"{LLAMA_CPP_PATH}",
            f"-m {model_full_path}",
            f"--embedding",
            f"--pooling {pooling}",
            f"-ub {ubatch_size}",
            f"--port {port}",
            f"--host {host}",
            f"-t {threads}",
            f"-ngl {ngl}"
        ]

        command = " ".join(command_parts)

        # Clear logs
        embedding_log_buffer.clear()
        while not embedding_log_queue.empty():
            embedding_log_queue.get()

        timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
        start_msg = f"[{timestamp}] STARTING EMBEDDING MODEL: {display_name} on {host}:{port} (pooling: {pooling} , with command : {command})"
        embedding_log_buffer.append(start_msg)
        embedding_log_queue.put(start_msg)

        embedding_process = subprocess.Popen(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            preexec_fn=os.setsid,
            env=env,
            bufsize=1,
            universal_newlines=False
        )

        log_reader(embedding_process, embedding_log_buffer, embedding_log_queue, "EMB")

        time.sleep(1)

        if embedding_process.poll() is not None:
            exit_code = embedding_process.poll()
            error_msg = f"Embedding process exited immediately with code {exit_code}"
            timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
            log_msg = f"[{timestamp}] CRITICAL ERROR: {error_msg}"
            embedding_log_buffer.append(log_msg)
            embedding_log_queue.put(log_msg)
            embedding_process = None
            return jsonify({"status": f"Error: {error_msg}", "success": False})

        return jsonify({"status": f"Embedding model '{display_name}' started on {host}:{port}", "success": True})

    except Exception as e:
        logger.exception(f"Error starting embedding model: {e}")
        return jsonify({"status": f"Error: {str(e)}", "success": False})

@app.route("/embedding/stop", methods=["POST"])
def stop_embedding_server():
    global embedding_process

    if embedding_process:
        try:
            os.killpg(os.getpgid(embedding_process.pid), signal.SIGTERM)
        except:
            pass
        embedding_process = None

    # Kill any remaining embedding processes on the specific port
    try:
        subprocess.run(["pkill", "-f", f"{LLAMA_CPP_PATH}.*--embedding"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except:
        pass

    return jsonify({"status": "Embedding server stopped!", "success": True})

#################################
#### Reranker Server Routes ####
#################################

@app.route("/reranker/start", methods=["POST"])
def start_reranker_server():
    global reranker_process
    if reranker_process:
        return jsonify({"status": "Reranker model is already running!", "success": False})

    try:
        model = request.form.get("reranker_model")
        if not model:
            return jsonify({"status": "No reranker model selected!", "success": False})

        port = request.form.get("reranker_port", os.getenv("RERANKER_DEFAULT_PORT", "8083"))
        host = request.form.get("reranker_host", "0.0.0.0")
        threads = request.form.get("reranker_threads", "2")
        ubatch_size = request.form.get("reranker_ubatch_size", "8192")
        ngl = request.form.get("reranker_ngl", "0")


        model_full_path = os.path.join(MODEL_DIR, model)
        display_name = os.path.basename(model).replace('.gguf', '')

        env = os.environ.copy()

        command_parts = [
            f"{LLAMA_CPP_PATH}",
            f"-m {model_full_path}",
            f"--reranking",
            f"-ub {ubatch_size}",
            f"--port {port}",
            f"--host {host}",
            f"-t {threads}",
            f"-ngl {ngl}"
        ]

        command = " ".join(command_parts)

        # Clear logs
        reranker_log_buffer.clear()
        while not reranker_log_queue.empty():
            reranker_log_queue.get()

        timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
        start_msg = f"[{timestamp}] STARTING RERANKER MODEL: {display_name} on {host}:{port} with command : {command}"
        reranker_log_buffer.append(start_msg)
        reranker_log_queue.put(start_msg)

        reranker_process = subprocess.Popen(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            preexec_fn=os.setsid,
            env=env,
            bufsize=1,
            universal_newlines=False
        )

        log_reader(reranker_process, reranker_log_buffer, reranker_log_queue, "RER")

        time.sleep(1)

        if reranker_process.poll() is not None:
            exit_code = reranker_process.poll()
            error_msg = f"Reranker process exited immediately with code {exit_code}"
            timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
            log_msg = f"[{timestamp}] CRITICAL ERROR: {error_msg}"
            reranker_log_buffer.append(log_msg)
            reranker_log_queue.put(log_msg)
            reranker_process = None
            return jsonify({"status": f"Error: {error_msg}", "success": False})

        return jsonify({"status": f"Reranker model '{display_name}' started on {host}:{port}", "success": True})

    except Exception as e:
        logger.exception(f"Error starting reranker model: {e}")
        return jsonify({"status": f"Error: {str(e)}", "success": False})

@app.route("/reranker/stop", methods=["POST"])
def stop_reranker_server():
    global reranker_process

    if reranker_process:
        try:
            os.killpg(os.getpgid(reranker_process.pid), signal.SIGTERM)
        except:
            pass
        reranker_process = None

    try:
        subprocess.run(["pkill", "-f", f"{LLAMA_CPP_PATH}.*--reranker"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except:
        pass

    return jsonify({"status": "Reranker server stopped!", "success": True})

#################################
#### Status Route ####
#################################

@app.route("/status")
def status():
    # Check custom apps status
    custom_apps_status = {}
    for app_id, process in custom_apps_processes.items():
        if process:
            custom_apps_status[app_id] = process.poll() is None

    return jsonify({
        "llm_running": llm_process is not None,
        "embedding_running": embedding_process is not None,
        "reranker_running": reranker_process is not None,
        "custom_apps": custom_apps_status
    })

#################################
#### Settings Persistence ####
#################################

SETTINGS_COOKIE = 'ui_settings'
SETTINGS_MAX_AGE = 60 * 60 * 24 * 30  # 30 days

#################################
#### Binary Update ####
#################################

from src.tg_llamacpp_update import run_update
update_binaries_process = None

@app.route("/update-binaries/start", methods=["POST"])
def start_update_binaries():
    global update_binaries_process

    if update_binaries_process and update_binaries_process.is_alive():
        return jsonify({"status": "Binary update is already running.", "success": False})

    try:
        update_binaries_log_buffer.clear()
        while not update_binaries_log_queue.empty():
            update_binaries_log_queue.get_nowait()

        update_binaries_progress["percent"] = 0
        update_binaries_progress["active"] = True

        def _worker():
            try:
                def log_callback(msg):
                    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
                    log_entry = f"[{timestamp}] UPDATE: {msg}"
                    update_binaries_log_buffer.append(log_entry)
                    update_binaries_log_queue.put(log_entry)

                def progress_callback(value):
                    update_binaries_progress["percent"] = min(max(value, 0), 100)

                msg = run_update(log_callback=log_callback, progress_callback=progress_callback, env_file_path=ENV_FILE_PATH)
                log_callback(msg)
                update_binaries_progress["percent"] = 100
            except Exception as e:
                logger.exception(f"Error during binary update: {e}")
                timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
                err_entry = f"[{timestamp}] UPDATE: Error: {e}"
                update_binaries_log_buffer.append(err_entry)
                update_binaries_log_queue.put(err_entry)
            finally:
                update_binaries_progress["active"] = False

        update_binaries_process = threading.Thread(target=_worker, daemon=True)
        update_binaries_process.start()

        return jsonify({"status": "Binary update started.", "success": True})
    except Exception as e:
        logger.exception(f"Error starting binary update: {e}")
        update_binaries_progress["active"] = False
        return jsonify({"status": f"Error: {str(e)}", "success": False})


@app.route("/update-binaries/logs")
def update_binaries_logs():
    entries = []
    try:
        while not update_binaries_log_queue.empty():
            entries.append({"text": update_binaries_log_queue.get_nowait()})
    except Exception as e:
        logger.error(f"Error getting update logs: {e}")
    return jsonify({"entries": entries, "reset": False})


@app.route("/update-binaries/status")
def update_binaries_status():
    running = bool(update_binaries_process and update_binaries_process.is_alive())
    return jsonify({
        "running": running,
        "percent": update_binaries_progress.get("percent", 0),
        "active": update_binaries_progress.get("active", False)
    })

#################################
#### .env File Management ####
#################################

ENV_FILE_PATH = os.path.join(os.path.dirname(__file__), '.env')

@app.route("/settings/env")
def list_env_variables():
    """List all .env variables"""
    try:
        variables = get_env_variables(ENV_FILE_PATH)
        return jsonify(variables)
    except Exception as e:
        logger.exception(f"Error listing env variables: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/settings/env", methods=["POST"])
def save_env_variable():
    """Save or update a .env variable"""
    try:
        data = request.get_json()
        key = data.get("key", "").strip()
        value = data.get("value", "").strip()

        if not key or not value:
            return jsonify({"status": "Key and value are required!", "success": False})

        # Validate key (only alphanumeric and underscores)
        if not key.isidentifier():
            return jsonify({"status": f"Invalid key name: {key}", "success": False})

        update_env_variable(ENV_FILE_PATH, key, value)
        return jsonify({
            "status": f"'{key}' saved successfully!",
            "success": True,
            "reload": True  # Signal public to reload
        })
    except Exception as e:
        logger.exception(f"Error saving env variable: {e}")
        return jsonify({"status": f"Error: {str(e)}", "success": False})

@app.route("/settings/env/<key>", methods=["DELETE"])
def delete_env_variable_route(key):
    """Delete a .env variable"""
    try:
        if not key.isidentifier():
            return jsonify({"status": f"Invalid key name: {key}", "success": False})

        deleted = delete_env_variable(ENV_FILE_PATH, key)
        if deleted:
            return jsonify({"status": f"'{key}' deleted!", "success": True, "reload": True})
        else:
            return jsonify({"status": f"'{key}' not found!", "success": False})
    except Exception as e:
        logger.exception(f"Error deleting env variable: {e}")
        return jsonify({"status": f"Error: {str(e)}", "success": False})

@app.route("/settings/save", methods=["POST"])
def save_settings():
    """Save UI settings to a session cookie"""
    try:
        data = request.get_json()
        if not data:
            return jsonify({"status": "No settings data received", "success": False})

        response = make_response(jsonify({"success": True}))
        response.set_cookie(SETTINGS_COOKIE, json.dumps(data), max_age=SETTINGS_MAX_AGE)
        return response
    except Exception as e:
        logger.exception(f"Error saving settings: {e}")
        return jsonify({"status": f"Error: {str(e)}", "success": False})

@app.route("/settings/load")
def load_settings():
    """Load UI settings from session cookie"""
    settings = request.cookies.get(SETTINGS_COOKIE, '')
    if not settings:
        return jsonify({})
    try:
        return jsonify(json.loads(settings))
    except Exception as e:
        logger.exception(f"Error loading settings: {e}")
        return jsonify({})

@app.route("/settings/clear", methods=["POST"])
def clear_settings():
    """Clear saved UI settings"""
    response = make_response(jsonify({"success": True}))
    response.delete_cookie(SETTINGS_COOKIE)
    return response

#################################
#### Startup ####
#################################

# Track startup warnings to display in UI
startup_warnings = []

if __name__ == "__main__":
    ensure_directories()
    logger.info("Starting Llama Model Controller server...")
    logger.info(f"LLM Model directory: {MODEL_DIR}")
    logger.info(f"Embedding Model directory: {EMBEDDING_MODEL_DIR}")
    logger.info(f"Reranker Model directory: {RERANKER_MODEL_DIR}")
    logger.info(f"llama.cpp server path: {LLAMA_CPP_PATH}")
    logger.info(f"Custom Apps env file: {CUSTOM_APPS_ENV_FILE}")

    if not os.path.exists(MODEL_DIR):
        os.makedirs(MODEL_DIR, exist_ok=True)

    if not os.path.exists(EMBEDDING_MODEL_DIR):
        os.makedirs(EMBEDDING_MODEL_DIR, exist_ok=True)

    if not os.path.exists(RERANKER_MODEL_DIR):
        os.makedirs(RERANKER_MODEL_DIR, exist_ok=True)

    if not os.path.exists(LLAMA_CPP_PATH):
        warning_msg = f"WARNING: llama-server executable not found at {LLAMA_CPP_PATH}. Server will start but LLM functionality may be limited."
        logger.error(warning_msg)
        startup_warnings.append(warning_msg)

    app.run(host="0.0.0.0", port=int(os.getenv("FLASK_APP_PORT", "5000")), debug=True)
