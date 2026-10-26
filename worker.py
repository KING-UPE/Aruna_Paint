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
TARGET_IDLE = 5

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

def handle_connection(win_sock):
    try:
        win_sock.settimeout(None)
        win_sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        first_chunk = win_sock.recv(8192)
        if not first_chunk:
            win_sock.close()
            return
        
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
        try:
            win_sock.close()
        except Exception:
            pass

def single_worker(on_exit):
    try:
        win_sock = socket.create_connection((WINDOWS_IP, WINDOWS_PORT), timeout=10)
        win_sock.settimeout(None)
        win_sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        handle_connection(win_sock)
    except Exception:
        time.sleep(0.5)
    finally:
        on_exit()

active_workers = 0
lock = threading.Lock()

def on_worker_exit():
    global active_workers
    with lock:
        active_workers -= 1

def main():
    global active_workers
    while True:
        with lock:
            needed = TARGET_IDLE - active_workers
            if needed > 0:
                for _ in range(needed):
                    active_workers += 1
                    t = threading.Thread(target=single_worker, args=(on_worker_exit,), daemon=True)
                    t.start()
        time.sleep(0.2)

if __name__ == '__main__':
    main()
