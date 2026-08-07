# luci-app-warpscan

LuCI-приложение для сканирования Cloudflare WARP эндпоинтов через ядерный
AmneziaWG с выбором лучшего и импортом в интерфейс `warp`.

## Состав
- `root/` — файлы пакета (устанавливаются в /usr, /www)
- `Makefile` — для сборки через OpenWrt SDK (`make package/luci-app-warpscan/compile`)
- `build.sh` — сборка `.ipk` напрямую на Ubuntu/Debian (SDK не нужен)
- `build/luci-app-warpscan_1.0-1_all.ipk` — готовый пакет

## Сборка на Ubuntu
```sh
# только build.sh
sudo apt install -y tar gzip
./build.sh            # -> build/luci-app-warpscan_1.0-1_all.ipk
./build.sh 1.1 2      # -> build/luci-app-warpscan_1.1-2_all.ipk
```

Или через OpenWrt SDK:
```sh
# положить каталог пакета в package/ внутри SDK и:
make package/luci-app-warpscan/compile
# ipk появится в bin/packages/.../luci/
```

## Установка на роутер (OpenWrt 24.10+, opkg)
```sh
opkg install luci-app-warpscan_1.0-1_all.ipk
# либо через LuCI: System -> Software -> Upload Package
```

## Зависимости
`amneziawg-tools`, `kmod-amneziawg`, `jq`, `curl`, `luci-base`, `rpcd-mod-ucode`
(при установке через opkg они дотянутся из репозитория, если настроен).

## Использование
- Меню: **Network -> Services -> WARP Scanner** (раздел «Службы»)
- При первой установке аккаунт создаётся кнопкой «Регистрация»
  (wregister.sh регистрируется напрямую или через туннель, если API закрыт)
- «Сканировать» — двухфазный скан (handshake-sweep + честный ICMP-пинг,
  порты `2408 1700 4500 500`), прогресс обновляется каждые ~3 сек,
  таблица отсортирована по пингу, лучший сверху
- «Импортировать лучший» — пишет лучший эндпоинт в
  `network.warp_peer.endpoint_host/port` и делает `network reload`
- «Скопировать .conf» (у каждой строки таблицы) — генерирует готовый
  AmneziaWG `.conf` с этим эндпоинтом и копирует в буфер обмена для импорта
  в приложение/клиент WARP. Параметры `Jc/Jmin/Jmax/I1`, ключи и `Address`
  берутся из текущего интерфейса `network.warp` / аккаунта.

## Формат ipk
OpenWrt 24.10 использует opkg 0.4+ где ipk = gzip-тар с тремя членами:
`debian-binary`, `data.tar.gz`, `control.tar.gz`. Именно так собирает `build.sh`.
