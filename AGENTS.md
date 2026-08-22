# AGENTS.md — контекст проекта (прочитай перед работой)

LuCI-приложение **RRWS (RouteRich WARP Scanner)** для OpenWrt-роутера RouteRich (192.168.1.1).
Сканирует Cloudflare WARP-эндпоинты через ядерный AmneziaWG, выдаёт `.conf`.
Роутер туннель НЕ поднимает. Первоисточник: https://github.com/vernette/warpscout
Гайд с портами/подсетями: https://help-guide.notion.site/Cloudflare-WARP-1f82684dab0d8024a1c8fec230f5e4e1

## Идентификаторы (после рефакторинга r71)
- Пакет: `luci-app-rrws`; ubus-объект: `luci.rrws`; файл бэкенда:
  `/usr/share/rpcd/ucode/luci.rrws`; скрипты: `/usr/bin/*.sh` (wscan/wregister/wsspeed);
  аккаунт: `/etc/rrws-account.json`; настройки: `/etc/rrws-settings.json`;
  сохранённый результат: `/etc/rrws-last-result.txt`; лог: `/tmp/rrws.rpc.log`;
  спид-тест: `/usr/bin/wsspeed.sh` (результат `/tmp/wsspeed_result.txt`,
  прогресс `/tmp/wsspeed/progress`, pid `/tmp/wsspeed/pid`, лог `/tmp/wsspeed.log`);
  пункт меню: `admin/services/rrws`, view `rrws/scan`, ACL `luci-app-rrws`.
  Изменения с r70 (warpscan→rrws) НЕ мигрируют старые файлы автоматически.
  С r15 скрипты переехали из `/usr/libexec/rrws/` в `/usr/bin/` (OpenWrt-конвенция;
  у zeroblock бинарь тоже в `/usr/bin`).
  Спид-тест (r78): ubus `speedStart/Status/Result/Stop/Log`, интерфейс `wgspeed`
  (IP `172.16.7.200`, table 102 + rule from IP prio 98). Поднимает обфусцированный
  туннель через `setconf` (как bootstrap) — на этой сети под DPI НЕобфусцированный
  интерфейс (как wscan-воркеры) handshake может НЕ давать, и wscan тогда находит
  0 живых, хотя эндпоинты живы (проверено 2026-08-09).
- Грабли спид-теста (r79): `/tmp/wsspeed.upload.bin` (8МБ, генерится один раз до
  цикла) НЕЛЬЗЯ удалять в teardown() — upload идёт `--data-binary @file` на
  каждом эндпоинте, и удаление после первого давало ul=0 у всех следующих.
  Уборка файла только в финальной очистке после цикла.
- Спид-тест (r80): «время на эндпоинт» — потолок каждого curl (`--max-time`),
  а не общий бюджет; сверху подъём интерфейса + ожидание handshake
  (`HS_SWEEP`, `wsspeed.sh:23`, теперь `min(8, MAX_TIME)`). Минимум времени
  замера 10с (UI + кламп бэкенда `max(10,...)`). На этой сети handshake через
  обфусцированный туннель даёт только UDP 2408 — не-2408 эндпоинты из
  порт-дискавери в спид-тесте дают 0; `162.159.193.1` занят локальным
  интерфейсом роутера.
- Регистрация (r96) — АСИНХРОННАЯ: `register`/`renewAccount` запускают
  wregister.sh в фоне (`setsid`, лог → `/tmp/rrws-register.log`, маркер
  `/tmp/rrws-registering` touch+trap EXIT) и возвращают `{started:true}` сразу.
  Причина: LuCI-клиент рвёт rpc-запросы через 20с (`L.env.rpctimeout`), а полная
  регистрация с bootstrap-туннелем занимает 40-60с → «XHR request timed out»
  при живом аккаунте. UI поллит `accountStatus` (поле `registering`),
  неудачу видно через `registerLog` (ACL read). Не путать: авторегистрация
  внутри `scanStart` осталась СИНХРОННОЙ (нужен ключ до старта скана).
- XHR-страховка (r97): все rpc-вызовы страницы идут через обёртку `rrwsDeclare`
  (scan.js), которая при XHR-ошибке сама перезагружает страницу (паттерн
  zeroblock) — UI полностью пересобирается с роутера, а не виснет с «XHR request
  timed out». Защита от цикла рефреша: не чаще раза в 30с (sessionStorage).
  Глобальный `unhandledrejection` ловит необработанные промисы.
- Бэкап (0.2.1-r1): файлы `/etc/rrws-account.json`, `/etc/rrws-settings.json`,
  `/etc/rrws-last-result.txt` включаются в sysupgrade/LuCI-бэкап через
  `/lib/upgrade/keep.d/luci-app-rrws` (механизм OpenWrt; `/sbin/sysupgrade`
  читает `/etc/sysupgrade.conf` + `/lib/upgrade/keep.d/*`, см. строку 165).
  Проверено: `sysupgrade -b` кладёт все три файла в tar.
- Лимиты (0.2.1-r4/r5, потолок воркеров снижен в r16→50 в r28): потолок хостов
  `HOSTS_MAX=4318` (17 подсетей × 254 октета = весь WARP-пул), потолок
  воркеров `JOBS_MAX=50` (IP-адреса воркеров `172.16.7.(2+w)`, `.200` занят
  `wgspeed`). Опытным путём: при 197 потоках у части роутеров ломается
  веб-интерфейс; с r27 воркеры ОБФУСЦИРОВАНЫ и пересоздают интерфейс на
  каждый эндпоинт (CPU-bound) — при 30-40 воркерах load 13-20 на 2-ядерном
  роутере, больше потоков не ускоряют, только грузят CPU. Потолок 50 —
  компромисс. КАК МЕНЯТЬ ЛИМИТ (полный чек-лист, все места):
  1. `luci.rrws` — константа `JOBS_MAX`/`HOSTS_MAX` в начале файла;
  2. `luci.rrws` — оба клампа `min(..., JOBS_MAX)`: в `saveSettings` и в `scanStart`;
  3. `scan.js` — `max` у поля input, `clampInput(input, 1, N)` и подпись
     «Потоков (1-N)» / «Хостов (1-N)»;
  4. `wscan.sh` — `[ "$JOBS" -gt N ] && JOBS=N` (и `-gt` для HOSTS в `-n`);
  5. build-память: физический потолок воркеров = адреса `172.16.7.x`, `.200`
     занят wgspeed → максимум 253, но UI/реальность диктуют 50;
  6. README/AGENTS/CHANGELOG — тексты подписей и описания лимитов.
- Фазы скана (0.2.1-r6): воркеры пишут в ОБЩИЙ `/tmp/wscan/progress` и
  перетирают друг друга — label фазы скакал phase1↔phase2 в UI. Решение:
  `scanStatus` в ucode считает фазу из агрегированных счётчиков
  `scanned.cnt` (все просканированные хосты) и `scanned2.cnt` (обработанные
  в фазе 2), label файла игнорируется. Фаза монотонна: phase1 пока
  `scanned1 < total`, дальше phase2; плюс `percent = max(percent, prev)`.
- Таймаут скана: это `HS_SWEEP` — ожидание handshake на КАЖДЫЙ порт в
  `try_endpoint`. Дефолт 3с, диапазон 1-10. 1с быстр, но на режущей сети
  может недобрать живых; цена завышения линейна (4 порта × timeout на
  мёртвый хост).
- Исключение подсетей (0.2.1-r7): UI-секция «Исключить подсети» — чекбоксы
  по 17 подсетям пула, сгруппированные по первому октету; сохранение через
  поле `exclude` в saveSettings/scanStart, валидация `valid_subnets()`
  (только известные подсети, без дублей), `getSettings` отдаёт `subnets`
  для восстановления чекбоксов. wscan.sh: флаг `-x 'subnet ...'` фильтрует
  `SUBNETS` до генерации списка хостов (для ex: `grep -v "^${ex}$"`).
  ВАЖНО (грабли сборки ucode): глобальные `join()`/`map()` в этой сборке
  возвращают null/undefined — для сериализации массивов использовать
  хелпер `join_list()` (ручной цикл), НЕ `join()`. Аргумент `-x` в команде
  запуска обёрнут в ДВОЙНЫЕ кавычки (` -x "a b"`), т.к. команда сама
  обёрнута в `sh -c '...'` и одинарные кавычки обрывают её.

## Среда
- ОС: Windows (pwsh). Shell для роутера: bash через `wsl -d Ubuntu-26.04 -- bash ...`
- WSL sudo: пароль `123456` (sudo без tty требует `echo PASSWORD | sudo -S ...`)
- Роутер: SSH `root@192.168.1.1` / `Stalkers2552` (через paramiko python)
- Установка ipk: base64 → `/tmp/warp.b64` → `openssl base64 -d -A` → opkg install
  → postinst сам делает `/etc/init.d/rpcd reload` (пересканирует ucode-каталог
  через SIGHUP→exec_self и НЕ сбрасывает LuCI-сессии, в отличие от restart;
  проверено на живом роутере 0.2.2).
- OpenWrt 25.12+ перешёл с opkg/.ipk на apk-tools/.apk (APKv3/ADB, магия `ADBd`):
  `build.sh <версия> apk` собирает `build/luci-app-rrws-<версия>.apk`
  через `apk mkpkg` (нужен apk-tools 3.x; в WSL стоит статический бинарник
  `/usr/local/bin/apk` из apk-tools-static-3.0.7). Для noarch-пакетов поле
  `arch:noarch` (в ipk было `all`); зависимости — повторяющиеся
  `--info "depends:..."`. Установка: `apk add --allow-untrusted <файл>.apk`.
  `build.sh <версия>` (или `both`) — по умолчанию ipk.
  Тест в WSL: `echo 123456 | sudo -S apk --root /tmp/apktest --initdb add 2>/dev/null`
  (создать БД), затем `apk add --root /tmp/apktest --simulate --allow-untrusted
  --force-non-repository <файл>.apk` — apk распарсит пакет и упрётся только
  в отсутствующие депы OpenWrt (rpcd-mod-ucode и т.п.) — это НОРМА и доказывает
  валидность apk; полная установка возможна только на роутере 25.12.
  ВАЖНО: `--root` нужен и в simulate — без него apk читает системную БД WSL
  и падает «Unable to read database».
- GitHub CLI `gh` отсутствует — для публикации релиза доступ даст пользователь

## Версии
- Схема: `x.y.z-rN` (r1..r99 → bump z). `./build.sh` автоинкрементит через
  `version.txt`; `./build.sh 0.2.5-r12` — точная. Артефакт (ipk):
  `build/luci-app-rrws_${VERSION}_all.ipk`; apk: `build/luci-app-rrws-${VERSION}.apk`.
  Бэкап в `backup_<timestamp>/`.
- ПАМЯТКА ПО СБОРКЕ: `BUILD.md` (шаги ipk/apk из Windows, тест apk в WSL,
  установка на роутер через SFTP, валидация исходников, грабли).
- Git: репо инициализирован, теги `v0.2.0-r5/r8/r10`. Файлы: .gitignore
  (исключает build/, backup*, *.ipk), .gitattributes (LF для sh/ucode/js).

## Текущее состояние (2026-08-22)
- Установлена 0.2.1-r40: дефолты параметров скана — Хостов 500, Таймаут 3с,
  Потоков 50, Пробных хостов (Discovery) 5. Обновлены scan.js (value + fallback),
  luci.rrws (дефолты saveSettings/scanStart) и wscan.sh (HOSTS_MAX=500,
  DISCOVER_HOSTS=5). В планах: скан через зарубежный прокси (vless://) —
  см. обсуждение в AGENTS «Прокси-скан».
- Установлена 0.2.1-r39: фикс спид-теста «Результатов нет» — после отката
  r38 парсер speedResult вернулся к 5-полю, а wsspeed.sh пишет 6 (с пингом);
  снова парсит `ep node loc rtt dl ul`. Пинг в спид-тесте работает.
- Установлена 0.2.1-r38: warp-in-warp ОТКАЧЕН из RRWS (секция UI, методы
  внутреннего аккаунта, -O/-K/-k удалены; файлы к r33). Причина: на ядерном
  kmod warp-in-warp меняет только узел, НЕ страну выхода (всегда RU), в
  отличие от userspace warpscout (DE/FRA) — тот же аккаунт/эндпоинт/конфиг
  даёт DE в userspace и RU в kernel. Полноценный warp-in-warp → новая версия
  RRWS2 на Go/userspace (amneziawg-go + netstack, как warpscout). Пинг в
  спид-тесте сохранён (r37). ВАЖНО: выход WARP на ядре всегда RU; userspace
  даёт узел-выход.
- Установлена 0.2.1-r37: warp-in-warp насквозь в UI/бэкенде — секция в UI
  (предупреждение про не-DME, поле внешнего эндпоинта, кнопка регистрации
  внутреннего аккаунта), scanStart передаёт -O/-K/-k. Проверено: внешний
  188.114.96.191:4500 → все результаты FRA. Спид-тест: добавлен пинг.
- Собран прототип r34 (не установлен как пакет): warp-in-warp в wscan.sh —
  флаги `-O`/`-K`/`-k`. Один внешний обфусц. туннель (таблица 199), воркеры
  (второй аккаунт) маршрутизируются через него (`ip rule from <worker-ip>
  lookup 199`) — каждый эндпоинт выходит через узел внешнего. Воркеры при
  вложении ≤3 (rate-limit). Проверено: внешний AMS → все результаты AMS.
  Нужен отдельный второй WARP-аккаунт (тест: /etc/rrws-inner-account.json).
  Откат: v0.2.1-r33.
- Установлена 0.2.1-r33: галка DME стабильно под dropdown исключения подсетей
  (добавляется в buildExcl после dropdown, а не сразу — раньше из-за
  асинхронного рендера могла быть над ним вплотную), отступ увеличен.
- Установлена 0.2.1-r32: UI — подпись «Исключить узел DME (Москва)» без
  «при выборе лучшего», увеличен отступ от блока «Исключить подсети».
- Установлена 0.2.1-r31: узел/страна в спид-тесте — плоский текст
  (`text-muted`), как в результатах скана (было бейджем label-info).
- Установлена 0.2.1-r30: спид-тест показывает узел/страну (WAW RU) в выводе и
  UI; прогресс-бар = доля текущего эндпоинта (6/10 → 60%). README: раздел
  «Узел (NODE) и страна (COUNTRY)» — узел входа ≠ страна выхода (можно
  подключиться к WAW, а сайты видят РФ; DME-исключение влияет на DPI, не на
  видимую страну).
- Установлена 0.2.1-r29: фикс спид-теста «0 кбит/с». Причина — DNS отдаёт
  speed.cloudflare.com в FakeIP (198.18.x), и curl через туннель к 198.18
  даёт http 000 (данные идут, trace работает, а speed-хост нет). Решение:
  wsspeed.sh резолвит реальный anycast IPv4 через внешний DNS (1.1.1.1),
  fallback 104.18.7.198, и передаёт `--resolve`. Проверено: dl 77-124 Мбит/с.
- Установлена 0.2.1-r27: воркеры ОБФУСЦИРОВАНЫ через setconf (endpoint в
  конфиге), смена эндпоинта = пересоздание интерфейса (kmod oops правило).
  Раньше необфусц. воркеры DPI рвал после handshake (rx=0) — trace пуст,
  «DME-only» был артефактом. Теперь curl через обфусц. воркер даёт реальные
  узлы (colo=WAW и др.), фича «исключить DME» осмысленна. Discovery остался
  необфусц. handshake-only (try_hs). Откат: тег v0.2.1-r26 (необфусц. воркеры).
- Установлена 0.2.1-r26: воркерам дана изоляция policy routing (каждая своя
  таблица 200+w + ip rule from <worker-ip> lookup ... prio 98). ВЫЯВЛЕН
  КОРЕНЬ «только DME»: необфусцированный воркер-туннель DPI режет после
  handshake (rx=0, данные не идут, trace пуст), а ОБФУСЦИРОВАННЫЙ (через
  setconf, как wsspeed) — работает (curl даёт colo=WAW и др.). Следующий шаг:
  обфусцировать воркеры через setconf, endpoint запекать в конфиг, смену
  эндпоинта делать пересозданием интерфейса (kmod oops правило).
- Установлена 0.2.1-r25: «Исключить узел DME» теперь глобально ДРОПИТ
  эндпоинты на исключённых узлах из результата (не ранжирует ниже). Проверено
  на живом: без исключения — 5 DME; с исключением DME — 0 строк (на этой
  сети только DME, так что пустой результат корректен).
- Установлена 0.2.1-r24: опция «Исключить узел DME» (UI чекбокс →
  `exclude_nodes` → флаг `-e DME`). wscan.sh при сортировке ставит эндпоинты
  на исключённых узлах ниже рабочих (но выше torn), `applyBest`/BEST
  предпочитают не-DME (например ARN), когда такие есть. Бэкенд `valid_nodes()`
  (только [A-Z0-9]{3,4}). Проверено: sort с `-e DME` поднимает ARN над DME.
- Установлена 0.2.1-r23: фикс парсинга API2 (`v0i1909051800` оборачивает
  ответ в `result:{}`, старый v0a4005 — плоский; парсер через `(.result // .)`
  понимает оба). Найдено тестом: v0a4005→404→retry API2→200, аккаунт
  сохранён. QUIC I1-маска проверена: handshake OK.
- Установлена 0.2.1-r22: запасные пути регистрации из warp-config-generator
  (llimonix) — bootstrap перебирает I1-маски (iCloud → 2 QUIC), плюс
  fallback API-путь `v0i1909051800` при HTTP-ошибке v0a4005. Проверено
  renewAccount: iCloud-I1 сработал первым, POST /reg=200, PATCH=200.
- Установлена 0.2.1-r21: фикс счётчика discovery — total теперь
  `HOSTS + 3 + HOSTS*53` (полный перебор идёт на каждый пробный хост),
  done клампится на total. Проверено: 5 хостов → total 278, done 1→278,
  без превышений.
- Установлена 0.2.1-r20: discovery-фаза показывает прогресс — wscan.sh пишет
  `discovery:<done>:<total>` в progress на каждую проверку, backend scanStatus
  считает процент (0-80%, монотонный), UI показывает «проверяю порты X/Y».
  Причина: на режущей UDP сети полный перебор 53 портов на 5 хостах занимал
  ~5.5 мин при баре на 0% (выглядело как зависание).
- Собрана 0.2.1-r19 (не установлена): юридическая атрибуция — MIT-текст
  warpscout в пакете (`/usr/share/licenses/luci-app-rrws/warpscout-LICENSE`)
  и README-раздел «Атрибуция: warpscout (MIT)». warpscout (© 2026 Nikita S.)
  лицензирован MIT; наш проект — переработка, MIT требует копирайт-уведомление.
- Установлена 0.2.1-r18: переименование в UI — пункт меню и заголовок страницы
  «RR WARP Scanner» (menu.d title + scan.js h2). Собраны ipk и apk.
- Установлена 0.2.1-r17: фикс cap поля «Эндпоинтов» теста скорости —
  кламп теперь динамический через функцию-max в `clampInput` (`speedCountCap`
  из `refreshSpeedAvailable`), кнопка запуска дополнительно клампит
  `[1, speedCountCap]`. См. CHANGELOG r17.
- Собрана 0.2.1-r16 (не установлена): потолок воркеров снижен 197 → 70
  (`JOBS_MAX` в ucode, `-gt 70` в wscan.sh, `max`/`clampInput`/подпись в
  scan.js). Причина — у части роутеров на 197 потоках полностью ломается
  веб-интерфейс; 70 — стабильный компромисс времени и нагрузки (см. «Лимиты»).
- Собрана 0.2.1-r15 (не установлена): скрипты переехали из `/usr/libexec/rrws/`
  в `/usr/bin/` (OpenWrt-конвенция, у zeroblock бинарь тоже в `/usr/bin`).
  BIN_DIR в luci.rrws = `/usr/bin`, обновлены build.sh/Makefile/.gitattributes/
  clean_test.sh/README/AGENTS. Проверено содержимым ipk: скрипты в `usr/bin/`,
  пустой `usr/libexec` убран.
- Установлена 0.2.1-r14: postinst ipk и post-install apk переведены с
  `rpcd restart` на `rpcd reload` — при установке больше не «выкидывает» из
  LuCI (reload пересканирует ucode через SIGHUP→exec_self и сохраняет сессии).
  apk раньше вообще не имел post-install (передаётся через
  `apk mkpkg --script "post-install:<path>"`, скрипт вне
  --files-дерева). Проверено на живом роутере: сессия ubus переживает reload
  (HTTP /ubus с sid отвечает `result:[0,...]` до и после), новый ucode-файл
  подхватывается без restart.
- Установлена 0.2.1-r7 (предыдущая актуальная): расширение области сканирования и
  лимитов (r4: `HOSTS_MAX=4318` — весь WARP-пул; r5: `JOBS_MAX=197` воркеров;
  r6: монотонные фазы скана; r7: исключение подсетей через UI — см.
  «Идентификаторы»). Проверено на живом роутере при 197 воркерах: роутер
  стабилен, память не растёт, CPU 100% — норма для I/O-bound воркеров.
  Прогресс-бары прячутся после завершения (r3), плашка «Регистрация...»
  на бейдже аккаунта (r2). Исключение подсетей проверено ubus-тестом:
  `-x` доходит до wscan.sh целиком, исключённые подсети (0 строк в
  hosts.txt), остальные 15 на месте.
- r69 (текущий исходник): probe API через поднятый bootstrap-туннель.
  handshake на `wgregb` НЕ гарантирует, что curl ходит в туннель (policy
  routing может не встать, эндпоинт занят локальным интерфейсом — см. r60).
  После `bootstrap_up` → `probe "$API/" "--interface $BOOT_IP" 15`; если
  API недостижим (000/timeout) → `bootstrap_down` → фолбэк на opera.
  `probe()` принимает 3-й параметр timeout (default 4). Проверено на живом
  роутере: nft `ip saddr 172.16.0.3 tcp dport 443 drop` (bootstrap handshake
  OK, API-443 режется) → probe 000 → opera reuse → POST/PATCH=200.
- Установлена 0.2.0-r68 (текущий исходник): ТРЕТИЙ резервный путь к API в
  wregister.sh — Opera Proxy. Порядок: direct → existing tunnel → bootstrap →
  opera. Когда bootstrap-туннель не смог подняться (все endpoint'ы отброшены
  handshake'ом), скрипт ставит `opera-proxy` (пакет Routerich, opkg install
  при отсутствии) и регистрируется через `curl -x http://127.0.0.1:18080`.
  Проверено на живом роутере под DPI (bootstrap принудительно сломан
  TEST-NET хостами): opera POST /reg=200, PATCH=200, аккаунт сохранён.
- ВАЖНО про opera-proxy: пакет ставит системный сервис (`/etc/init.d/opera-proxy`,
  procd `respawn 3600 5 0`), который воскрешает процесс через 5с после любого
  `killall`. Поэтому opera_down убивает ТОЛЬКО свой PID (временный экземпляр),
  а если на порту 18080 уже слушает чужой (системный сервис) — он ПЕРЕИСПОЛЬЗУЕТСЯ
  и не трогается. Никогда не используй `killall opera-proxy` в wregister.sh.
  Teardown вынесен в `teardown_path()`, описания путей — в `path_name()`.
  На роутере сервис opera-proxy отключен (disable) — поднимается только
  временный экземпляр при необходимости.
- Установлена 0.2.0-r66 — РЕАЛЬНОЕ решение регистрации под провайдерским
  DPI. Причина зависаний r63/r65 найдена в kernel oops (pstore): kmod
  разыменовывает bad pointer, когда junk-параметры заданы частично
  (jc/jmin/jmax/i1 без S1-S4/H1-H4) либо при живой мутации обфусц.
  интерфейса через `amneziawg set peer ...`. Решение: строить bootstrap-
  интерфейс ТОЧНО как встроенные TestWarp/TW2 — полный набор обфускации
  (Jc=6 Jmin=10 Jmax=50 S1-S4=0 H1-H4=1..4 I1=<DNS-masq>) через
  `amneziawg setconf <файл>` с endpoint'ом в конфиге; после setconf никаких
  `amneziawg set` на обфусц. интерфейсе, смена эндпоинта = пересоздание.
  Проверено на живом роутере при заблокированном api.cloudflareclient.com
  (direct 000): handshake OK, POST /reg=200, PATCH=200, warp_enabled=true,
  интерфейс подчищен, uptime стабилен; работает и через ubus
  (luci.warpscan register).
- r67 (текущий исходник): подробное логирование bootstrap-фазы — каждый
  endpoint, rc setconf, статус handshake по попыткам, ip route/rule err,
  route check, сводка tried N endpoints. Вызов bootstrap_up больше НЕ
  глушится `>/dev/null 2>&1` — логи видны в output ubus и rpc.log.
- Проверено на чистом роутере (factory reset, RouteRich 24.10.8, фиды
  routerich из /rom возвращаются сами): `opkg update` + `opkg install
  /tmp/warp.ipk` тянет kmod-amneziawg автоматически (r61 добавил его в
  Depends), postinst делает `rpcd restart`. После установки ssh/LuCI
  «выкидывает» из роутера — это рестарт rpcd сбрасывает сессии
  (не баг, случается раз при установке). Регистрация кнопкой «Зарегистрировать
  WARP» на чистом роутере работает напрямую: probe api 404 (достижима),
  POST /reg 200, PATCH 200, аккаунт в /etc/warpscan-account.json.
  r62: warp_enabled в файле честный (true после успешного PATCH).
- Установлена 0.2.0-r60 (bootstrap-туннель доведён до рабочего состояния).
  r57-r59 давали ЛОЖНЫЙ «успех»: handshake на интерфейсе ещё не означает,
  что curl через `--interface 172.16.0.3` ходит в туннель. Реальная
  механика, проверенная на роутере с nft-блокировкой прямого пути:
  (1) bootstrap-ключи handshake дают НЕ все эндпоинты — `162.159.193.1:2408`
  и `8.34.146.1:2408` заняты локальными интерфейсами (warp/TestWarp),
  рабочие: `188.114.96.3:2408`, `162.159.192.1:2408`, `188.114.97.1:2408`;
  (2) нужен policy routing: `ip route add default dev wgregb table 101` +
  `ip rule add from 172.16.0.3/32 lookup 101 prio 98`, иначе трафик с
  172.16.0.3 идёт по обычному маршруту роутера, а не в туннель;
  (3) cleanup в bootstrap_down снимает rule+route и удаляет интерфейс.
  Проверено: `-t nosuchiface` + nft drop на eth1 (api 000) → POST /reg
  http 200, PATCH http 200, аккаунт сохранён, wgregb/rule/route удалены.
- Ключ bootstrap передаётся через временный файл /tmp/wr_boot.key, НЕ через
  `<(...)` process substitution (хотя busybox ash этого роутера его понимает,
  `cat <(echo hi)` работает — проверено; файл надёжнее для других билдов).
- Установлена 0.2.0-r56 (подробное логирование регистрации. wregister.sh
  теперь логирует каждый шаг в stderr с префиксом `[wregister]`: генерация
  ключей, прямой probe API (curl_exit + http_code), fallback через туннель
  с проверкой существования интерфейса, POST register (curl_exit + http_code
  + curl stderr + тело при ошибке), PATCH enable warp, маппинг curl-ошибок в
  тексты (6=DNS, 7=connect, 28=timeout...), проверка `id` в ответе. Бэкенд
  логирует результат регистрации целиком в /tmp/warpscan.rpc.log
  (register/renewAccount/scanStart auto-register). Проверено: на этом роутере
  регистрация работает — direct timeout (curl_exit=28) → fallback через
  интерфейс warp → http 200 OK, аккаунт сохраняется. «api unreachable even
  via tunnel» у пользователя = интерфейс fallback-туннеля не существует/не
  поднят или не маршрутизирует наружу — теперь видно из лога wregister.sh).
- Установлена 0.2.0-r55 (в ipk добавлен postinst-скрипт с
  `/etc/init.d/rpcd restart` — rpcd кэширует ucode-объекты на старте, без
  рестарта после установки все методы luci.warpscan дают «Object not found»
  (register/renewAccount/deleteAccount/accountStatus/version). Раньше рестарт
  делался только вручную в install-скрипте, у других пользователей пакет
  падал). Также: ucode-файл не должен быть world-writable (rpcd игнорирует
  такие молча) — в ipk chmod 644 это чинит.
- Установлена 0.2.0-r54 (лимит потоков 12 → 32: scan.js max/clampInput,
  luci.warpscan min(...,32) x2, wscan.sh -gt 32; роутер 2-ядерный, воркеры
  I/O-bound — спокойно тянет; потолок реально ~250 воркеров по подсети
  172.16.7.x для интерфейсов wgscanN).
- Установлена 0.2.0-r53 (лимит потоков поднят 12 → 24).
- Установлена 0.2.0-r52 (тексты подтверждений перерегистрации/удаления аккаунта
  исправлены: старые ключи Cloudflare НЕ отзывает — они продолжают работать;
  прежний текст про «старые ключи станут недействительны» был неверен).
  r51: бейдж «Зарегистрирован» снова зелёный (сброс inline-стиля красного).
  r50: бейдж «Не зарегистрирован» красный (#d9534f). r49: кнопки аккаунта
  лежат горизонтальной строкой на строке заголовка «Аккаунт WARP» —
  справа, flex-wrap:wrap; ID/Address сразу под заголовком, gap ~10px).
  r48: кнопки аккаунта перенесены на строку заголовка
  «Аккаунт WARP» (сначала колонкой — было слишком большое расстояние до ID).
  r47: кнопки аккаунта прижаты
  к правому краю (margin-left:auto), в Discovery Mode добавлено слово «порт».
  r46: убрана
  дублирующая строка «Аккаунт WARP
  зарегистрирован» — её показывает бейдж в шапке; текст «через AmneziaWG» без
  «ядерный»). Шапка страницы в стиле zeroblock (H2 «WARP Scanner» +
  описание с версией из opkg-метаданных + бейдж статуса аккаунта; новый
  rpcd-метод `version`). r44: фикс r43 — восстановлена случайно удалённая строка
  `const scanned_total = ...` в scanStatus → ubus scanStatus снова работает;
  поллинг прогресса и кнопки/результаты в UI корректны. Кнопки аккаунта блокируются на время скана; есть
  кнопка «Остановить» (r43, scanStop в бэкенде: PID wscan.sh → PGID из
  /proc → kill -TERM группе, чистка wgscan*/wgprobe, progress=done).
  Фильтры стран/узлов УДАЛЕНЫ (r41). Числовые поля
  (Хостов 1-600, Таймаут 1-10, Потоков 1-12, Пробных хостов 1-10) клампятся
  в диапазон через clampInput() в scan.js (r42; `max` на type=number ввод
  не запрещает). Порт-лист `2408 1701 4500 500`; умный port-discovery
  (fast-path 2408 ~1с → fallback 1701/4500/500 n=2, потом 53 порта) — ОПЦИЯ:
  флаг wscan.sh `-D`, параметр scanStart `discover:1`, UI-чекбокс «Discovery Mode».
  По умолчанию выключен — скан поведёт себя как раньше (без discovery).
- Управление аккаунтом WARP в UI: «Зарегистрировать WARP» (аккаунта нет),
  «Перерегистрировать» и «Удалить аккаунт» (с подтверждением). Методы rpcd:
  `register`, `renewAccount`, `deleteAccount`; файл `/etc/warpscan-account.json`.
- Реализовано: монотонный прогресс-бар, параллельный скан (воркёры wgscan0..N-1,
  `-j` 1..12), блокировка кнопок, TUN PING/LOSS + детект «torn down» (r8),
  персистентное сохранение результатов (`/etc/warpscan-last-result.txt`),
  дата скана в шапке, догон поллинга при focus, адаптивный port-discovery
  (`discover_ports()` в wscan.sh, r14-r16).
- Кнопки UI: «Быстрый поиск», «Полный поиск (долго!)», «Скачать всё .txt»,
  «Скопировать .conf» / «Показать .conf» у каждой строки.

## Диагностика стран выхода (2026-08-08)
- Скан 150 хостов без фильтра: 98 живых эndpoint'ов, ВСЕ дают `DME RU`.
  На этой сети (провайдер РФ) любой anycast-эндпоинт Cloudflare резолвится
  в московский узел; выход WARP всегда `RU`. Выбор exit-страны через фильтр
  невозможен — фильтр работает, но реально достижим только RU.
- При пустом свежем результате scanResult больше НЕ падает на сохранённый
  файл (r40) — UI честно показывает «Рабочих эndpoint'ов не найдено».
- Фильтрация по странам/узлам УДАЛЕНА (r41): UI-пикеры, `-c`/`-x` в wscan.sh,
  `countries`/`exclude_nodes` в scanStart/saveSettings, `filter_list()` в ucode.
  Причина — на этой сети достижим только `RU`-выход, фильтр был бесполезен.

## Файлы
- `root/usr/bin/wscan.sh` — скан (воркеры, фазы, вывод)
- `root/usr/share/rpcd/ucode/luci.rrws` — бэкенд (scanStart/Status/Result)
- `root/www/luci-static/resources/view/rrws/scan.js` — фронтенд
- `root/usr/bin/wregister.sh` — регистрация аккаунта
- `/etc/rrws-account.json` — аккаунт (переживает ребут)

## Формат вывода wscan.sh (важно, парсится бэкендом)
`ip:port NODE COUNTRY rtt tun_rtt tun_loss torn(1=down)`
Сортировка: рабочие (torn=0) по rtt вверх, torn — в конец. BEST никогда из torn.

## Известные грабли
- `bash -n` в WSL ломается от CRLF; файлы должны оставаться LF (gitattributes).
- `node --check` валидирует scan.js (Windows), а `dash -n` НЕ годится для wscan.sh
  (нет process substitution `<(echo)`) — только `bash -n` в WSL.
- busybox ping выводит `seq=N` (не `icmp_seq=`); `-i` принимает только целые сек.
- **kmod-amneziawg на этом роутере падает с panic (oops, reboot), если обфускация
  задана частично** — только jc/jmin/jmax+i1 БЕЗ S1-S4/H1-H4, ИЛИ при мутации
  интерфейса в живую (`amneziawg set peer remove/add/endpoint`) после setconf
  с junk-параметрами. РАБОЧИЙ способ: полный набор (Jc/Jmin/Jmax+S1-S4+H1-H4+I1)
  через `amneziawg setconf <configfile>` с endpoint в конфиге, после чего НЕ
  трогать peer через `amneziawg set`. Смена эндпоинта = пересоздание интерфейса.
  Образец рабочей конфигурации — встроенные интерфейсы TestWarp/TW2 (см.
  /etc/config/network). Синтаксис junk в конфиг-файле с `=` (Jc=6), в set — без.
- Расширенный список портов (53 шт.) через тупой перебор замедляет скан при
  режущем 2408 — сделан умный port-discovery в wscan.sh `discover_ports()`:
  fast-path (только 2408 на 2 хостах, ~1с) → если 2408 режут, slow-path ищет
  рабочие порты (1701/4500/500 c n=2, потом 53 порта c n=1) и сужает $PORTS.
  На незаблокированной сети порты не меняются (проверено: «network passes UDP»).
- try_endpoint с n=1 не ловит handshake даже на рабочем порту — для discovery
  фолбэки бери с n=2.
- После смены ucode всегда `/etc/init.d/rpcd reload` (пересканирует ucode
  через SIGHUP→exec_self, сессии LuCI сохраняются; restart тоже работает, но
  сбрасывает сессии — reload предпочтительнее).
- rpcd сканирует /usr/share/rpcd/ucode/ при старте/exec_self и **молча игнорирует**
  world-writable ucode-файлы. Поэтому: (1) в ipk обязателен postinst с
  `rpcd reload` (иначе у других пользователей «Object not found» на все методы),
  (2) в build_ipk файлы получают chmod 644 (в Windows-исходниках у
  luci.rrws права 0777 — за счёт WSL-mount).
- PowerShell экранирование ломает python -c с кавычками — пиши скрипт в файл
  (Temp/opencode) или через base64.

## Прокси-скан (vless://) — обсуждение, НЕ реализовано
- Задача: пользователь имеет свой зарубежный прокси (ссылка `vless://`) и хочет
  сканировать WARP через него (зарубежный выход). Без зарубежного пути исхода
  (VPS/туннель) зарубежный выход невозможен в принципе — страну выхода назначает
  шлюз Cloudflare по географии источника (проверено: на роутере всегда RU, и в
  ядре, и в userspace warpscout).
- Идея: пропустить трафик воркеров через VLESS-туннель. У воркеров уже есть
  изоляция (свой IP 172.16.7.(2+w) + таблица 200+w + rule prio 98) — в
  прокси-режиме дефолт в этих таблицах направляется в tun-устройство вместо WAN.
- Варианты реализации:
  1. v1 (ядерный): на роутере sing-box (tun inbound + vless outbound) или
     xray (SOCKS5+UDP) + hev-socks5-tunnel (tun). UI: поле vless://, парсер,
     генерация конфига, методы proxyStart/Stop/Status, флаг скана -P.
  2. RRWS2 (userspace Go): встроить xray-core/sing-box как библиотеку, парсить
     vless:// нативно, гнать UDP-сокеты WG через неё — без роутерных таблиц.
- Ограничения: сервер должен разрешать UDP (XUDP/packet_encoding); все пакеты
  идут одним TCP-потоком → head-of-line blocking, потоки клампить до ~10-16 в
  прокси-режиме; RTT станет «через прокси»; MTU туннеля ниже (handshake мелкие —
  не пострадают). Внутри шифрованного VLESS DPI не видит WG — обфускация воркеров
  не обязательна. Проверка страны выхода (trace) покажет регион прокси — это цель.

## Проверка без UI
- Скан: ubus POST /cgi-bin/luci/admin/ubus, login root, затем luci.rrws
  scanStart {hosts,timeout,mode,jobs} → poll scanStatus → scanResult.
- Файлы на роутере: /tmp/wscan/* (hosts, alive, scanned.cnt, percent),
  /tmp/wscan_result.txt, /tmp/wscan.log, /tmp/rrws.rpc.log.
