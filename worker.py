import socket
import threading
import time
import subprocess
import sys

def get_windows_ip():
    try:
        out = subprocess.check_output("ip route show default", shell=True).decode()
        for part in out.split():
            if part.count('.') == 3:
                return part
    except Exception:
        pass
    return "172.28.224.1"

WINDOWS_IP = get_windows_ip()
WINDOWS_PORT = 5433
PG_PORT = 5432
TARGET_IDLE = 10

print(f"WSL PG Bridge Worker starting. Windows IP: {WINDOWS_IP}:{WINDOWS_PORT}", flush=True)

def pipe(src, dst):
    while True:
        try:
            data = src.recv(8192)
            if not data:
                break
            dst.sendall(data)
        except Exception:
            break
    try:
        src.close()
    except Exception:
        pass
    try:
        dst.close()
    except Exception:
        pass

idle_workers = 0
lock = threading.Lock()

def single_worker():
    global idle_workers
    is_idle = True
    try:
        win_sock = socket.create_connection((WINDOWS_IP, WINDOWS_PORT), timeout=10)
        win_sock.settimeout(None)
        win_sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)

        # Worker is waiting for client data from Windows
        first_chunk = win_sock.recv(8192)
        if not first_chunk:
            win_sock.close()
            return

        with lock:
            if is_idle:
                idle_workers -= 1
                is_idle = False

        pg_sock = socket.create_connection(('127.0.0.1', PG_PORT), timeout=5)
        pg_sock.settimeout(None)
        pg_sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        pg_sock.sendall(first_chunk)

        t1 = threading.Thread(target=pipe, args=(win_sock, pg_sock), daemon=True)
        t2 = threading.Thread(target=pipe, args=(pg_sock, win_sock), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
    except Exception:
        pass
    finally:
        with lock:
            if is_idle:
                idle_workers -= 1
                is_idle = False

def main():
    global idle_workers
    while True:
        with lock:
            needed = TARGET_IDLE - idle_workers
            if needed > 0:
                for _ in range(needed):
                    idle_workers += 1
                    t = threading.Thread(target=single_worker, daemon=True)
                    t.start()
        time.sleep(0.1)

if __name__ == '__main__':
    main()
