# models.py - Model discovery functions
import os
from src.tg_config import MODEL_DIR, EMBEDDING_MODEL_DIR, RERANKER_MODEL_DIR

def get_models(directory=MODEL_DIR, include_subdirs=True):
    """
    Retrieve all available GGUF models from directory.
    Returns list of dicts with model info.
    """
    models_data = []
    mmproj_models = {}

    if not os.path.exists(directory):
        return [], {}

    all_files = []
    mmproj_files = {}

    for root, dirs, files in os.walk(directory):
        for f in files:
            if f.endswith(".gguf"):
                full_path = os.path.join(root, f)
                rel_path = os.path.relpath(full_path, directory)
                all_files.append(rel_path)

                if "mmproj" in f.lower() or "mproj" in f.lower():
                    folder = os.path.dirname(rel_path)
                    if folder not in mmproj_files:
                        mmproj_files[folder] = []
                    mmproj_files[folder].append(f)

    for rel_path in all_files:
        filename = os.path.basename(rel_path)
        folder = os.path.dirname(rel_path)

        if "mmproj" in filename.lower() or "mproj" in filename.lower():
            continue

        base_name = filename.replace('.gguf', '')
        is_vision = False
        mmproj_path = None

        if folder in mmproj_files:
            for mmproj_file in mmproj_files[folder]:
                is_vision = True
                mmproj_path = os.path.join(folder, mmproj_file)
                mmproj_models[rel_path] = mmproj_path
                break

        display_name = base_name
        if is_vision:
            display_name += " - vision"

        models_data.append({
            'path': rel_path,
            'display_name': display_name,
            'is_vision': is_vision,
            'mmproj_path': mmproj_path,
            'full_path': os.path.join(directory, rel_path)
        })

    models_data.sort(key=lambda x: x['display_name'])
    return models_data, mmproj_models

def get_embedding_models():
    """Get embedding models from embedding directory or main directory with 'embed' in name"""
    models = []
    seen_paths = set()

    # Check dedicated embedding directory first
    if os.path.exists(EMBEDDING_MODEL_DIR):
        for root, dirs, files in os.walk(EMBEDDING_MODEL_DIR):
            for f in files:
                if f.endswith(".gguf"):
                    full_path = os.path.join(root, f)
                    rel_path = os.path.relpath(full_path, MODEL_DIR)

                    if rel_path not in seen_paths:
                        seen_paths.add(rel_path)
                        models.append({
                            'path': rel_path,
                            'display_name': f.replace('.gguf', ''),
                            'full_path': full_path
                        })

    # Also check for models with 'embed' in name in main directory
    all_models, _ = get_models(MODEL_DIR)
    for model in all_models:
        if 'embed' in model['display_name'].lower():
            if model['path'] not in seen_paths:
                seen_paths.add(model['path'])
                models.append({
                    'path': model['path'],
                    'display_name': model['display_name'],
                    'full_path': model['full_path']
                })

    models.sort(key=lambda x: x['display_name'])
    return models

def get_reranker_models():
    """Get reranker models from reranker directory"""
    models = []
    seen_paths = set()

    if os.path.exists(RERANKER_MODEL_DIR):
        for root, dirs, files in os.walk(RERANKER_MODEL_DIR):
            for f in files:
                if f.endswith(".gguf"):
                    full_path = os.path.join(root, f)
                    rel_path = os.path.relpath(full_path, MODEL_DIR)

                    if rel_path not in seen_paths:
                        seen_paths.add(rel_path)
                        models.append({
                            'path': rel_path,
                            'display_name': f.replace('.gguf', ''),
                            'full_path': full_path
                        })

    models.sort(key=lambda x: x['display_name'])
    return models
