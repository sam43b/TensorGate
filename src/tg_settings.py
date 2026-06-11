# tg_settings.py - .env file management for Settings UI
import os
import logging

logger = logging.getLogger(__name__)


def read_env_file(env_file_path):
    """Read .env file and return list of key-value pairs."""
    variables = []
    if not os.path.exists(env_file_path):
        logger.warning(f".env file not found at {env_file_path}")
        return variables

    try:
        with open(env_file_path, 'r') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if '=' in line:
                    key, value = line.split('=', 1)
                    variables.append({
                        'key': key.strip(),
                        'value': value.strip(),
                        'line_num': line_num,
                        'comment': ''
                    })
    except Exception as e:
        logger.error(f"Error reading .env file: {e}")

    return variables


def update_env_variable(env_file_path, key, new_value):
    """Update or add a variable in the .env file."""
    if not os.path.exists(env_file_path):
        with open(env_file_path, 'w') as f:
            f.write(f"{key}={new_value}\n")
        return True

    lines = []
    found = False
    comment_lines = []

    try:
        with open(env_file_path, 'r') as f:
            for line in f:
                stripped = line.strip()
                if stripped.startswith('#'):
                    comment_lines.append(line)
                    continue
                if stripped.startswith(f"{key}="):
                    lines.extend(comment_lines)
                    comment_lines = []
                    lines.append(f"{key}={new_value}\n")
                    found = True
                else:
                    lines.extend(comment_lines)
                    comment_lines = []
                    lines.append(line)
            lines.extend(comment_lines)

        if not found:
            # Add new variable with blank line separator
            lines.insert(0, '\n')
            lines.append(f"{key}={new_value}\n")

        with open(env_file_path, 'w') as f:
            f.writelines(lines)

        return True
    except Exception as e:
        logger.error(f"Error updating .env variable: {e}")
        return False


def delete_env_variable(env_file_path, key):
    """Remove a variable from the .env file."""
    if not os.path.exists(env_file_path):
        return False

    try:
        with open(env_file_path, 'r') as f:
            lines = f.readlines()

        new_lines = [line for line in lines if not line.strip().startswith(f"{key}=")]

        with open(env_file_path, 'w') as f:
            f.writelines(new_lines)

        return True
    except Exception as e:
        logger.error(f"Error deleting .env variable: {e}")
        return False


def get_env_variables(env_file_path):
    """Get all variables from the .env file."""
    return read_env_file(env_file_path)
