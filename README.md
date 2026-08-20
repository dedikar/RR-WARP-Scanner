# RR WARP Scanner (luci-app-rrws)

LuCI-приложение для роутера RouteRich, которое сканирует эндпоинты Cloudflare WARP
через ядерный [AmneziaWG](https://github.com/amnezia-vpn/amneziawg-linux-kernel-module), находит
самые быстрые и даёт готовые `.conf` для импорта в клиент WARP.

Сканирование идёт **прямо на роутере**: реальный handshake до каждого
эндпоинта, честный ICMP-пинг, проверка туннеля (TUN PING / LOSS) и детект
«torn down» эндпоинтов. Никакого внешнего компьютера не нужно.

Проект — переработка [warpscout](https://github.com/vernette/warpscout) под роутер RouteRich и веб-интерфейс LuCI.

**[English README](README.en.md)**

## Скриншот

![RR WARP Scanner — интерфейс](.github/assets/rrws-scan.png)

## Содержание

- [Возможности](#возможности)
- [Требования](#требования)
- [Установка](#установка)
- [Использование](#использование)
- [Discovery Mode](#discovery-mode-умный-поиск-портов)
- [Как работает скан](#как-работает-скан)
- [Формат результата](#формат-результата)
- [Файлы](#файлы)
- [Сборка](#сборка)
- [Ограничения и заметки](#ограничения-и-заметки)
- [Лицензия](#лицензия)

## Возможности

- **Двухфазный скан** — быстрая разведка handshake'ами (`phase 1`), затем
  честная задержка и проверка туннеля для выживших (`phase 2`).
- **Параллельность** — до 50 воркеров (`wgscan0..N-1`), каждый со своим
  туннелем, делят список хостов по кругу.
- **Честный пинг** — задержка к эндпоинту измеряется ICMP RTT до хоста,
  а не через туннель/curl.
- **TUN PING / LOSS** — ICMP-пакет в туннель (до 1.1.1.1) на каждый
  эндпоинт: считается задержка, потери и детект «torn down» (DPI оборвал
  туннель посреди серии). Такие эндпоинты показываются, но никогда не
  выбираются лучшими.
- **Гибкий объём скана** — поле «Хостов» от 1 до 4318 (весь пул):
  быстрые прогоны на десятках хостов или полный перебор всех подсетей.
- **Исключение подсетей** — чекбоксами можно пропустить часть из 17 подсетей
  WARP-пула (например, заведомо мёртвые или нежелательные).
- **Исключение узла DME** — опция «Исключить узел DME (Москва)» убирает все
  эндпоинты, попавшие на московский узел (фильтруется DPI внутри РФ).
- **Умный port-discovery** (опционально) — подстраивается под блокировки
  UDP сети.
- **Управление аккаунтом WARP** — регистрация, перерегистрация, удаление
  прямо из UI; аккаунт хранится в `/etc/rrws-account.json` и переживает
  ребут.
- **Монотонный прогресс-бар**, дата скана, персистентные результаты
  (`/etc/rrws-last-result.txt`).
- **Тест скорости** — замер `download/upload` через `wgspeed` (`172.16.7.200`,
  обфусцированный туннель `setconf` + `table 102`/`rule prio 98`) по топ-N
  рабочим эндпоинтам из результата скана (`speed.cloudflare.com` с `--resolve`
  реального IP).
- **Бэкап стандартными средствами** — аккаунт, настройки и последний результат
  (`/etc/rrws-account.json`, `/etc/rrws-settings.json`,
  `/etc/rrws-last-result.txt`) включаются в штатный бэкап OpenWrt
  (sysupgrade / LuCI Backup) через `/lib/upgrade/keep.d/luci-app-rrws` —
  после восстановления прошивки пакет работает с прежним аккаунтом.
- **Готовые `.conf`** — копирование или просмотр AmneziaWG-конфига для
  каждого найденного эндпоинта, с обфускацией `Jc/Jmin/Jmax/H1-4/I1`.

## Требования

Роутер RouteRich на OpenWrt 24.10+ с поддержкой AmneziaWG. Зависимости
пакета:

- `amneziawg-tools`, `kmod-amneziawg`
- `jq`, `curl`
- `luci-base`, `rpcd-mod-ucode`

При установке через `opkg` они дотянутся автоматически, если в системе
настроен репозиторий с пакетами AmneziaWG.

## Установка

Соберите пакет (см. «Сборка») и установите:

```sh
opkg install luci-app-rrws_0.2.1-r39_all.ipk
```

Либо через LuCI: **System → Software → Upload Package**.

После установки обновите страницу с очисткой кэша (Ctrl+Shift+R). Приложение
появится в **Services → RR WARP Scanner**.

## Использование

### Управление аккаунтом

Для скана нужен ключ WARP. Если аккаунта ещё нет — нажмите
**«Зарегистрировать WARP»**: скрипт создаст его сам, а если API Cloudflare
заблокирован, попробует добраться до него через временный туннель, а при
неудаче — через локальный HTTP-прокси (пакет `opera-proxy`, ставится из
фидов RouteRich). Доступны также «Перерегистрировать» (свежие ключи) и
«Удалить аккаунт».

### Параметры скана

- **Хостов** (весь пул: 4318) — сколько эндпоинтов проверить.
- **Таймаут (сек)** (1–10) — время ожидания handshake на порт.
- **Потоков** (1–50) — параллельных воркеров.
- **Discovery Mode** + **Пробных хостов** — см. ниже.

### Кнопки

- **Найти туннели** — запустить скан с выбранными параметрами.
- **Остановить** — прервать текущий скан.
- **Скачать всё .txt** — сохранить все результаты.
- **Скопировать .conf / Показать .conf** — у каждой строки таблицы:
  готовый AmneziaWG-конфиг для этого эндпоинта. Ключи, `Address`, параметры
  обфускации берутся из аккаунта/интерфейса `network.warp`.

Во время скана кнопки блокируются, прогресс-бар монотонный. Результат
сортируется по пингу, лучший сверху; «torn down» — в конце.

## Discovery Mode (умный поиск портов)

Опция **«Включить Discovery Mode»** в UI (флаг `-D` у wscan.sh, параметр
`discover:1` в scanStart). Перед основным сканом проверяет, какие UDP-порты
пропускает сеть, чтобы не перебирать заблокированные порты на каждом хосте.

Как работает (`discover_ports()` в wscan.sh), на временном интерфейсе
`wgprobe`:

1. **Fast-path**: первые `N` эндпоинтов списка проверяются на порту `2408`
   (первичный). Если хоть один ответил — сеть пропускает UDP, порты не
   меняются, расходуется ~2 сек.
2. **Slow-path** (2408 заблокирован): на тех же пробных хостах перебираются
   `1701 → 4500 → 500`, затем, если все мертвы, ещё 53 порта. Найденные
   рабочие порты подставляются в скан, заблокированные не перепроверяются.

**Пробных хостов** (1–10, по умолчанию 2) — сколько эндпоинтов участвует в
проверке портов до основного скана. Больше — надёжнее, но дольше: каждый
пробный хост, не ответивший на 2408, гоняет перебор портов (до 53 проб).
Меньше (1–2) — быстрее, но если первые хосты списка мёртвые, можно ошибочно
решить, что порт закрыт.

По умолчанию Discovery Mode выключен — скан ведёт себя как раньше с фикс-
рованным списком портов `2408 1701 4500 500`.

## Как работает скан

```
scanStart (rpcd/ucode)
  └─ wscan.sh -n N -t T -j J [-f] [-D [-P N]]
       ├─ generate host list (интерливинг подсетей, full/fast)
       ├─ [discover_ports()]  — подбор портов
       ├─ worker wgscan0..J-1, каждый:
       │    phase 1: handshake-sweep по $PORTS → alive-файл
       │    phase 2: host_rtt (ICMP) + честный handshake + trace_meta
       │             + tun_probe (TUN PING / LOSS / torn) → wscan_result.txt
       └─ сортировка: рабочие по rtt вверх, torn — в конец
scanStatus (polling UI) ← /tmp/wscan/progress
scanResult (UI) ← /tmp/wscan_result.txt (или сохранённый при отсутствии)
```

Выход из туннеля снимается через `curl https://1.1.1.1/cdn-cgi/trace`
внутри туннеля — поля `colo|loc` (узел/страна выхода).

## Узел (NODE) и страна (COUNTRY) — в чём разница

В результатах у каждого эндпоинта два поля, которые легко перепутать:

- **NODE** — узел Cloudflare, к которому ты подключаешься (точка входа,
  аэропорт-код: DME=Москва, WAW=Варшава, AMS=Амстердам, FRA=Франкфурт,
  ARN=Стокгольм). Зависит от того, куда маршрутизируется эндпоинт с твоей сети.
- **COUNTRY (SEEN AS)** — страна, из которой внешние сайты видят твой трафик
  (точка выхода WARP). Определяется маршрутизацией WARP-аккаунта, а **не**
  узлом входа.

**Важно: можно подключиться к Варшаве (WAW) и всё равно «выходить» из РФ.**
Узел входа и страна выхода — разные вещи: туннель может войти в Варшаву, но
Cloudflare выпустить трафик через российский узел. Поэтому «взял конфиг
WAW RU, а сайты всё равно видят РФ» — это нормально, а не баг.

Тогда зачем исключать DME? Узел входа влияет на **фильтрацию DPI**: трафик
через московский узел (DME) фильтруется внутри РФ (часть сайтов не грузится),
а через зарубежные узлы (WAW/AMS/FRA/ARN) — нет, даже если страна выхода
всё равно RU. Опция «Исключить узел DME» убирает именно фильтруемый московский
узел, чтобы эндпоинты грузились стабильно.

Если же цель — чтобы сайты видели **не РФ**, выбор эндпоинта/узла не поможет:
нужна другая точка входа (например, VPS за рубежом).

## Формат результата

`ip:port  NODE  COUNTRY  rtt  tun_rtt  tun_loss  torn`

Пример строки:

```
162.159.192.142:2408  AMS  NL  23.1  18.4  0  0
```

| Поле | Смысл |
|---|---|
| `ip:port` | эндпоинт |
| `NODE` | узел выхода (colo) |
| `COUNTRY` | страна выхода (loc) |
| `rtt` | ICMP RTT до эндпоинта, мс |
| `tun_rtt` | задержка через туннель (TUN PING), мс |
| `tun_loss` | потери через туннель, % |
| `torn` | `1` = туннель оборван DPI (никогда не выбирается лучшим) |

## Файлы

### Пакет (`root/`)

- `root/usr/bin/wscan.sh` — сканер (воркеры, фазы, discovery)
- `root/usr/bin/wregister.sh` — регистрация/перерегистрация аккаунта
- `root/usr/bin/wsspeed.sh` — спид-тест (обфусцированный туннель)
- `root/usr/share/rpcd/ucode/luci.rrws` — бэкенд rpcd (scanStart/Status/Result, аккаунт, настройки)
- `root/usr/share/rpcd/acl.d/luci-app-rrws.json` — ACL для ubus-методов
- `root/usr/share/luci/menu.d/rrws.json` — пункт меню LuCI
- `root/www/luci-static/resources/view/rrws/scan.js` — фронтенд

### На роутере (runtime)

- `/etc/rrws-account.json` — аккаунт WARP (переживает ребут)
- `/etc/rrws-settings.json` — сохранённые параметры UI
- `/etc/rrws-last-result.txt` — последний результат (для истории)
- `/tmp/wscan_result.txt` — свежий результат скана
- `/tmp/wscan.log`, `/tmp/rrws.rpc.log` — логи
- `/tmp/wscan/` — рабочие файлы (hosts, alive, progress, percent)

## Сборка

Схема версий: `x.y.z-rN` (r1..r99 → затем bump z, сброс r1).

```sh
# просто build.sh — автоинкремент версии из version.txt
./build.sh

# или точная версия
./build.sh 0.2.1-r39

# результат: build/luci-app-rrws_0.2.1-r39_all.ipk
```

`build.sh` работает на Ubuntu/Debian, SDK не нужен — пакет pure-скриптовый
(`PKGARCH=all`). ipk собирается как gzip-тар из `debian-binary`,
`data.tar.gz`, `control.tar.gz` (формат opkg 0.4+ / OpenWrt 24.10).

Либо через OpenWrt SDK:

```sh
# положить каталог пакета в package/ внутри SDK и:
make package/luci-app-rrws/compile
```

## Ограничения и заметки

- Сканирование не поднимает туннель на роутере — оно использует временные
  интерфейсы `wgscan0..N-1` и удаляет их после завершения.
- Сканирующие интерфейсы (`wgscan0..N-1`) поднимаются обфусцированными
  через `amneziawg setconf` (полный набор `Jc/Jmin/Jmax+S1-S4+H1-H4+I1` с
  endpoint в конфиге, интерфейс пересоздаётся на каждый эндпоинт — иначе
  `kmod-amneziawg` падает с oops). Без обфускации DPI рвал бы туннель
  сразу после handshake (данные не шли). Выдаваемые `.conf` используют те же
  параметры.
- Файлы скриптов должны оставаться LF (не CRLF) — иначе bash/ash в
  OpenWrt и WSL спотыкаются на переводах строк.
- Метод `applyBest` в бэкенде при необходимости сам пишет лучший эндпоинт
  в `network.<iface>_peer` (endpoint_host/port) и делает `network reload`.

## Лицензия

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platform: OpenWrt 24.10+](https://img.shields.io/badge/platform-OpenWrt%2024.10%2B-green.svg)](#требования)
[![Protocol: AmneziaWG](https://img.shields.io/badge/protocol-AmneziaWG-orange.svg)](https://github.com/amnezia-vpn/amneziawg-linux-kernel-module)
[![MIT (warpscout)](https://img.shields.io/badge/warpscout-MIT-yellow.svg)](https://github.com/vernette/warpscout)

Apache-2.0.

### Атрибуция: warpscout (MIT)

Этот проект — переработка [warpscout](https://github.com/vernette/warpscout)
(https://github.com/vernette/warpscout), Copyright (c) 2026 Nikita S.,
лицензированного под MIT License:

> MIT License
>
> Copyright (c) 2026 Nikita S.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
