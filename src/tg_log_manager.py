# log_manager.py - Log buffer and queue management
import threading
import time
import re
import logging
import queue
from collections import deque

logger = logging.getLogger(__name__)

# Log buffers
llm_log_buffer = deque(maxlen=1000)
embedding_log_buffer = deque(maxlen=1000)
reranker_log_buffer = deque(maxlen=1000)
llm_log_queue = queue.Queue()
embedding_log_queue = queue.Queue()
reranker_log_queue = queue.Queue()

# Custom Apps Log buffers
custom_apps_log_buffers = {}  # {app_name: deque}
custom_apps_log_queues = {}   # {app_name: queue}
update_binaries_log_buffer = deque(maxlen=2000)
update_binaries_log_queue = queue.Queue()
update_binaries_progress = {"percent": 0, "active": False}

# Prompt processing progress tracking
prompt_progress = {"value": 0.0, "active": False}

# Generation status tracking
generation_state = {"state": "idle", "last_change": time.time()}
last_signal_time = {"prompt": 0, "eval": 0, "n_decoded": 0, "idle": 0}

def _set_state(new_state):
    global generation_state
    now = time.time()
    if generation_state["state"] != new_state:
        generation_state["state"] = new_state
        generation_state["last_change"] = now

def log_reader(process, log_buffer, log_queue, prefix):
    """Read logs from process stdout/stderr"""
    progress_regex_new = re.compile(r"prompt processing,\s*n_tokens\s*=\s*\d+,\s*progress\s*=\s*([\d.]+)")
    progress_regex_old = re.compile(r"(?:prompt processing progress|processing progress).*?(?:progress\s*[=:]\s*|:\s*)([\d.]+)")
    done_regex = re.compile(r"n_decoded\s*=\s*\d+.*?tg\s*=")
    done_explicit_regex = re.compile(r"prompt processing done")
    eval_regex = re.compile(r"eval time\s*=")
    idle_regex = re.compile(r"all slots are idle")
    prompt_eval_regex = re.compile(r"prompt eval time\s*=")

    def read_stream(stream, stream_prefix):
        global last_signal_time
        is_llm = stream_prefix.startswith("LLM")
        display_prefix = stream_prefix.removesuffix("-ERR").removesuffix("-OUT")

        for line in iter(stream.readline, b''):
            try:
                line_str = line.decode('utf-8').rstrip()
                timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
                log_entry = f"[{timestamp}] {display_prefix}: {line_str}"
                log_buffer.append(log_entry)
                log_queue.put(log_entry)

                if is_llm:
                    now = time.time()
                    progress_match = progress_regex_new.search(line_str)
                    if progress_match:
                        raw_val = float(progress_match.group(1))
                        progress_val = min(raw_val * 100, 100.0)
                        prompt_progress["value"] = round(progress_val, 2)
                        prompt_progress["active"] = True
                        last_signal_time["prompt"] = now
                        _set_state("prompt_processing")
                    else:
                        progress_match = progress_regex_old.search(line_str)
                        if progress_match:
                            raw_val = float(progress_match.group(1))
                            progress_val = raw_val if raw_val > 1.0 else raw_val * 100
                            prompt_progress["value"] = round(min(progress_val, 100.0), 2)
                            prompt_progress["active"] = True
                            last_signal_time["prompt"] = now
                            _set_state("prompt_processing")
                        elif prompt_eval_regex.search(line_str):
                            last_signal_time["eval"] = now
                            _set_state("generating")
                        elif eval_regex.search(line_str):
                            last_signal_time["eval"] = now
                            _set_state("generating")
                        elif done_regex.search(line_str) or done_explicit_regex.search(line_str):
                            prompt_progress["value"] = 100.0
                            prompt_progress["active"] = True
                            last_signal_time["n_decoded"] = now
                            _set_state("generating")
                        elif idle_regex.search(line_str):
                            last_signal_time["idle"] = now
                            _set_state("idle")

                logger.debug(f"Log: {log_entry}")
            except Exception as e:
                logger.error(f"Error processing log line: {e}")

    threading.Thread(target=read_stream, args=(process.stdout, f"{prefix}-OUT"), daemon=True).start()
    threading.Thread(target=read_stream, args=(process.stderr, f"{prefix}-ERR"), daemon=True).start()

def get_generation_state():
    """Return current generation state based on recent log activity"""
    now = time.time()
    state = generation_state["state"]

    if state == "prompt_processing":
        if (now - last_signal_time["prompt"]) > 30 and (now - last_signal_time["eval"]) > 5:
            _set_state("idle")
            state = "idle"
    elif state == "generating":
        if (now - last_signal_time["n_decoded"]) > 10 and (now - last_signal_time["eval"]) > 10:
            _set_state("idle")
            state = "idle"

    return state
