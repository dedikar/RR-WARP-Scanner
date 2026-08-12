#!/bin/sh
# Тест 0.2.0-r61 на чистом роутере (RouteRich, OpenWrt 24.10.8)
# Запуск:   sh /tmp/warpclean.sh
# Вход:     /tmp/warp.b64  (base64 от luci-app-rrws_0.2.0-r61_all.ipk)
#           кладётся на роутер отдельно (SCP/WinSCP) или вставляется так:
#           cat > /tmp/warp.b64  (затем Ctrl-D)
# Выход:    /tmp/warpclean.log — скинуть мне этот файл

exec > /tmp/warpclean.log 2>&1
echo "===== WARP CLEAN TEST $(date) ====="
echo "--- os ---"
cat /etc/os-release | head -3
uname -r
echo "--- feeds ---"
cat /etc/opkg/distfeeds.conf

echo "--- opkg update ---"
opkg update

echo "--- install from b64 ---"
[ -s /tmp/warp.b64 ] || { echo "NO /tmp/warp.b64"; exit 1; }
openssl base64 -d -A -in /tmp/warp.b64 -out /tmp/warp.ipk
ls -l /tmp/warp.ipk
opkg install /tmp/warp.ipk
echo "--- rpcd check ---"
sleep 1
ubus call luci.rrws version
echo "--- installed pkgs ---"
opkg list-installed | grep -E "rrws|amneziawg"

echo "--- direct probe ---"
curl -s -o /dev/null --max-time 5 -w "api_direct=%{http_code}\n" https://api.cloudflareclient.com/ 

echo "--- REGISTER (default path, may bootstrap) ---"
rm -f /etc/rrws-account.json
sh /usr/bin/wregister.sh -o /tmp/warpclean_account.json
echo "rc_register=$?"
echo "--- account ---"
cat /tmp/warpclean_account.json 2>&1

echo "--- interfaces after register ---"
ip -o link show | grep -E "warp|wgregb"
echo "--- warp handshake ---"
amneziawg show warp latest-handshakes 2>&1

echo "--- SCAN quick (10 hosts) ---"
ubus -S call luci.rrws scanStart '{"hosts":10,"timeout":2,"mode":"fast","jobs":4}' 
sleep 20
ubus -S call luci.rrws scanStatus
ubus -S call luci.rrws scanResult

echo "===== END $(date) ====="
