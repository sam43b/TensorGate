# config.py - Configuration variables
import os
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

HOME_DIR = os.path.expanduser("~")
MODEL_DIR = os.path.expanduser(os.getenv("MODEL_DIR", "/mnt/Data/llm"))
EMBEDDING_MODEL_DIR = os.path.expanduser(os.getenv("EMBEDDING_MODEL_DIR", "/mnt/Data/embeding"))
RERANKER_MODEL_DIR = os.path.expanduser(os.getenv("RERANKER_MODEL_DIR", "/mnt/Data/reranker"))
LLAMA_CPP_PATH = os.path.expanduser(os.getenv("LLAMA_CPP_PATH", "/home/sam/Appz/llama_cpp/build/bin/llama-server"))
CACHE_DIR = os.path.expanduser("~/.cache/llama")

# Custom Apps Configuration
APPS_ENV_DIR = Path(__file__).resolve().parent.parent
CUSTOM_APPS_ENV_FILE = os.path.join(APPS_ENV_DIR, "custom_apps.cfg")
PRESETS_FILE = os.path.join(APPS_ENV_DIR, "presets.cfg")

# Context size options
CONTEXT_OPTIONS = {
    "4k": 4096,
    "8k": 8192,
    "16k": 16384,
    "24k": 24448,
    "32k": 32768,
    "64k": 65536,
    "128k": 131072,
    "256k": 262144,
    "512k": 524288,
    "1M": 1048576
}

# KV Cache Type options
KV_CACHE_OPTIONS = {
    "F32": "f32",
    "F16": "f16",
    "BF16": "bf16",
    "Q8_0": "q8_0",
    "Q5_1": "q5_1",
    "Q5_0": "q5_0",
    "Q4_1": "q4_1",
    "IQ4_NL": "iq4_nl",
    "Q4_0": "q4_0"
}

# Pooling options for embedding models
POOLING_OPTIONS = ["none", "mean", "cls", "last", "rank"]
