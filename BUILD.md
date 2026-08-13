# Сборка luci-app-rrws — памятка

## Кратко
Сборка без SDK, чистыми скриптами: исходники в `root/`, результат в `build/`.
Единственный вход: `./build.sh` (bash, WSL). Makefile в репо — старый артефакт
warpscan, НЕ используется.

## Версии
- Схема: `x.y.z-rN` (r1..r99, потом `x.y.(z+1)-r1`).
- `version.txt` хранит последнюю версию.
- `./build.sh` — автоинкремент из version.txt.
- `./build.sh 0.2.1-r7` — точная версия.
- `./build.sh <ver> apk` — только apk; `both` — оба; по умолчанию ipk.
- После сборки version.txt перезаписывается.

## Форматы
| Формат | Код | Артефакт | OpenWrt | Установка |
|---|---|---|---|---|
| ipk (opkg) | `./build.sh <ver>` | `build/luci-app-rrws_<ver>_all.ipk` | 24.x | `opkg install` |
| apk (apk-tools) | `./build.sh <ver> apk` | `build/luci-app-rrws-<ver>.apk` | 25.12+ | `apk add` |

- ipk: gzip-tar из `debian-binary` + `data.tar.gz` + `control.tar.gz` (opkg>=0.4).
  Внутри postinst с `/etc/init.d/rpcd reload` (reload пересканирует ucode через
  SIGHUP→exec_self и сохраняет LuCI-сессии; restart тоже работает, но «выкидывает»
  из LuCI).
- apk: APKv3/ADB (магия `ADBd`), `apk mkpkg`. Для noarch — `arch:noarch`
  (в ipk было `all`); зависимости — повторяющиеся `--info "depends:..."`.
  Нужен apk-tools 3.x (в WSL: `/usr/local/bin/apk` из apk-tools-static-3.0.7).

## Внутренности build.sh
- Копирует `root/` в temp, ставит chmod 644 на файлы / 755 на `*.sh`
  (в Windows-исходниках права сломаны из-за WSL-mount).
- ipk: control (Depends: amneziawg-tools, kmod-amneziawg, jq, curl,
  luci-base, rpcd-mod-ucode) + postinst.
- apk: те же зависимости через повторяющиеся `--info "depends:..."`.

## Сборка из Windows (шаг за шагом)
```powershell
# ipk (по умолчанию)
wsl -d Ubuntu-26.04 -- bash -lc "cd /mnt/c/Users/dedikar/warp && ./build.sh 0.2.1-r7"

# apk под 25.12
wsl -d Ubuntu-26.04 -- bash -lc "cd /mnt/c/Users/dedikar/warp && ./build.sh 0.2.1-r7 apk"

# оба
wsl -d Ubuntu-26.04 -- bash -lc "cd /mnt/c/Users/dedikar/warp && ./build.sh 0.2.1-r7 both"
```

## Тест apk в WSL (без роутера)
Проверяет, что apk валидный (распарсится и развернётся). Упор в депы OpenWrt
(rpcd-mod-ucode и т.п.) — НОРМА, полная установка возможна только на 25.12.
```bash
echo 123456 | sudo -S apk --root /tmp/apktest --initdb add 2>/dev/null
apk add --root /tmp/apktest --simulate --allow-untrusted --force-non-repository /mnt/c/Users/dedikar/warp/build/luci-app-rrws-<ver>.apk
```

## Установка на роутер
Роутер: `root@192.168.1.1` / `Stalkers2552` (paramiko python).

### ipk (24.x) — через SFTP (sftp-server доступен)
```python
import paramiko
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect('192.168.1.1', username='root', password='Stalkers2552', timeout=15)
sftp = c.open_sftp()
sftp.put(r'C:\Users\dedikar\warp\build\luci-app-rrws_<ver>_all.ipk', '/tmp/luci-app-rrws_<ver>_all.ipk')
sftp.close()
i,o,e = c.exec_command('opkg install --force-reinstall /tmp/luci-app-rrws_<ver>_all.ipk 2>&1', timeout=120)
print(o.read().decode(errors='replace'))
c.exec_command('/etc/init.d/rpcd reload')
```
После установки postinst сам делает `rpcd reload` (пересканирует ucode,
сессии сохраняются) — ручной restart не нужен.

### ipk — старый путь (без SFTP): base64
`base64` ipk → `/tmp/warp.b64` → `openssl base64 -d -A` → `opkg install`.

## Проверка после установки
```bash
ubus call luci.rrws getSettings     # бэкенд жив (нет «Object not found»)
ubus call luci.rrws version
```

## Валидация исходников перед сборкой
- `bash -n` для *.sh — только в WSL (busybox ash не понимает process substitution;
  `dash -n` не годится). Файлы должны быть LF (gitattributes), CRLF ломает `bash -n`.
- `node --check` для scan.js (Windows-ок).
- ucode проверяется только на роутере (убус) — тестового бинарника нет.

## Грабли
- PowerShell экранирование ломает `python -c` с кавычками и вложенные bash —
  пиши скрипты в файлы (`C:\Users\dedikar\AppData\Local\Temp\opencode\*.py`).
- ucode-файл не должен быть world-writable (rpcd игнорирует молча) — build.sh
  ставит 644.
- В этой сборке ucode глобальные `join()`/`map()` возвращают null/undefined —
  сериализацию массивов делать через хелпер `join_list()` (ручной цикл).
- `-x 'a b'` в команде запуска: команда обёрнута в `sh -c '...'`, поэтому аргумент
  исключений оборачивается в ДВОЙНЫЕ кавычки (` -x "a b"`), иначе одинарные
  обрывают внешнюю кавычку и теряется вторая подсеть.
- `sudo` в WSL без tty: `echo 123456 | sudo -S ...` (пароль 123456).
