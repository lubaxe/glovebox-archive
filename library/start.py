"""Run the internal recording helper and Gunicorn; fail if either process exits."""
import signal
import subprocess
import time

processes = []
def stop(*_):
    for process in processes:
        if process.poll() is None:
            process.terminate()

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    processes.append(subprocess.Popen(['/usr/local/bin/recording-server']))
    processes.append(subprocess.Popen(['gunicorn', '--bind', '0.0.0.0:8000', '--workers', '1', '--threads', '32', '--timeout', '1800', 'app:app']))
    while all(process.poll() is None for process in processes):
        time.sleep(.5)
finally:
    stop()
    for process in processes:
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
