# system.py - System statistics gathering
import psutil

try:
    import GPUtil
except ImportError:
    GPUtil = None


def _format_memory_bytes(b, unit="auto"):
    """Format bytes as MB or GB, choosing the more readable unit.

    Uses GB when value >= 1 GB, otherwise MB.
    """
    gb = b / (1024 ** 3)
    mb = b / (1024 ** 2)
    if unit == "GB":
        return f"{gb:.1f}GB"
    if unit == "MB":
        return f"{mb:.0f}MB"
    if gb >= 1.0:
        return f"{gb:.1f}GB"
    return f"{mb:.0f}MB"


def get_system_stats():
    """Get CPU, RAM and GPU usage stats"""
    stats = {"cpu": {}, "memory": {}, "gpus": []}

    try:
        cpu_percent = psutil.cpu_percent(interval=0.1)
        cpu_count = psutil.cpu_count()
        cpu_freq = psutil.cpu_freq()

        stats["cpu"] = {
            "usage_percent": f"{cpu_percent}%",
            "cores": cpu_count,
            "frequency": f"{cpu_freq.current:.0f}MHz" if cpu_freq else "N/A"
        }
    except Exception as e:
        stats["cpu"] = {"error": str(e)}

    try:
        mem = psutil.virtual_memory()
        swap = psutil.swap_memory()

        stats["memory"] = {
            "total": f"{mem.total / (1024**3):.1f}GB",
            "used": f"{mem.used / (1024**3):.1f}GB",
            "percent": f"{mem.percent}%",
            "swap_used": f"{swap.used / (1024**3):.1f}GB",
            "swap_total": f"{swap.total / (1024**3):.1f}GB"
        }
    except Exception as e:
        stats["memory"] = {"error": str(e)}

    if GPUtil is not None:
        try:
            gpus = GPUtil.getGPUs()
            for gpu in gpus:
                stats["gpus"].append({
                    "index": gpu.id,
                    "name": gpu.name,
                    "temp": f"{gpu.temperature}°C" if gpu.temperature else "N/A",
                    "usage": f"{gpu.load * 100:.1f}%",
                    "memory": f"{_format_memory_bytes(gpu.memoryUsed)} / {_format_memory_bytes(gpu.memoryTotal)}"
                })
        except Exception:
            pass

    if not stats["gpus"]:
        try:
            import py3nvml.py3nvml as nvml
            nvml.nvmlInit()
            device_count = nvml.nvmlDeviceGetCount()
            for i in range(device_count):
                handle = nvml.nvmlDeviceGetHandleByIndex(i)
                name = nvml.nvmlDeviceGetName(handle)
                mem_info = nvml.nvmlDeviceGetMemoryInfo(handle)
                util = nvml.nvmlDeviceGetUtilizationRates(handle)
                temp = nvml.nvmlDeviceGetTemperature(handle, nvml.NVML_TEMPERATURE_GPU)
                stats["gpus"].append({
                    "index": i,
                    "name": name,
                    "temp": f"{temp}°C",
                    "usage": f"{util.gpu}%",
                    "memory": f"{_format_memory_bytes(mem_info.used)} / {_format_memory_bytes(mem_info.total)}"
                })
            nvml.nvmlShutdown()
        except Exception:
            pass

    if not stats["gpus"]:
        try:
            import os
            drm_dir = "/sys/class/drm"
            if os.path.isdir(drm_dir):
                for entry in sorted(os.listdir(drm_dir)):
                    if not entry.startswith("card") or entry.count("-") > 0:
                        continue
                    device_dir = os.path.join(drm_dir, entry, "device")
                    if not os.path.isdir(device_dir):
                        continue
                    vendor_path = os.path.join(device_dir, "vendor")
                    device_path = os.path.join(device_dir, "device")
                    if not os.path.isfile(vendor_path) or not os.path.isfile(device_path):
                        continue
                    try:
                        with open(vendor_path) as f:
                            vendor = f.read().strip()
                    except Exception:
                        continue
                    if vendor != "0x1002":
                        continue
                    name = "GPU USAGE"
                    temp = "N/A"
                    hwmon_dir = os.path.join(device_dir, "hwmon")
                    if os.path.isdir(hwmon_dir):
                        for hw in sorted(os.listdir(hwmon_dir)):
                            hw_path = os.path.join(hwmon_dir, hw)
                            temp_input = os.path.join(hw_path, "temp1_input")
                            if os.path.isfile(temp_input):
                                try:
                                    with open(temp_input) as f:
                                        temp = f"{int(f.read().strip()) / 1000:.0f}°C"
                                        break
                                except Exception:
                                    pass
                    usage = "N/A"
                    busy_path = os.path.join(device_dir, "gpu_busy_percent")
                    if os.path.isfile(busy_path):
                        try:
                            with open(busy_path) as f:
                                usage = f"{float(f.read().strip()):.1f}%"
                        except Exception:
                            pass
                    memory = "N/A"
                    mem_used_path = os.path.join(device_dir, "mem_info_vram_used")
                    mem_total_path = os.path.join(device_dir, "mem_info_vram_total")
                    if os.path.isfile(mem_used_path) and os.path.isfile(mem_total_path):
                        try:
                            with open(mem_used_path) as f:
                                used = int(f.read().strip())
                            with open(mem_total_path) as f:
                                total = int(f.read().strip())
                            memory = f"{_format_memory_bytes(used)} / {_format_memory_bytes(total)}"
                        except Exception:
                            pass
                    stats["gpus"].append({
                        "index": entry.replace("card", ""),
                        "name": name,
                        "temp": temp,
                        "usage": usage,
                        "memory": memory
                    })
        except Exception:
            pass

    if not stats["gpus"]:
        stats["gpus"] = [{"error": "No GPU monitoring library available"}]

    return stats
