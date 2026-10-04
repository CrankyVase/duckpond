"""Deploy only Duck Pond's PowerShell wrappers; never install or change drivers."""
import subprocess
from pathlib import Path
from bridge import SSH, WORKER


def sync_worker():
    root = Path(__file__).resolve().parent
    target = WORKER.rsplit('\\', 1)[0].replace('\\', '/')
    identity = SSH[SSH.index('-i') + 1]
    host = SSH[-1]
    for name in ('windows-cache.ps1', 'windows-worker.ps1', 'windows-image.ps1'):
        subprocess.run(['scp', '-q', '-i', identity, '-o', 'BatchMode=yes', '-o',
                        'ConnectTimeout=10', str(root / name), f'{host}:{target}/{name}'],
                       check=True, timeout=45)
    print('Windows worker scripts synchronized; model files and drivers unchanged.')


if __name__ == '__main__':
    sync_worker()
