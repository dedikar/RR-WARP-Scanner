# luci-app-rrws Makefile for OpenWrt
# Build with SDK: make package/luci-app-rrws/compile

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-rrws
PKG_VERSION:=1.0
PKG_RELEASE:=1

PKG_LICENSE:=MIT
PKG_LICENSE_FILES:=
PKG_MAINTAINER:=RRWS <dev@route-rich.local>

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-rrws
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=RR WARP Scanner for AmneziaWG
  URL:=https://github.com/vernette/warpscout
  PKGARCH:=all
  DEPENDS:=+amneziawg-tools +kmod-amneziawg +jq +curl +luci-base +rpcd-mod-ucode
endef

define Package/luci-app-rrws/description
  Scan Cloudflare WARP endpoints via kernel AmneziaWG,
  pick the best and import it into the warp interface.
  Provides a LuCI page under Services -> RR WARP Scanner.
endef

define Package/luci-app-rrws/postinst
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
/etc/init.d/rpcd reload >/dev/null 2>&1
rm -f /tmp/luci-indexcache* /tmp/luci-modulecache 2>/dev/null
exit 0
endef

define Package/luci-app-rrws/postrm
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
/etc/init.d/rpcd reload >/dev/null 2>&1
rm -f /tmp/luci-indexcache* /tmp/luci-modulecache 2>/dev/null
exit 0
endef

define Build/Prepare
endef

define Build/Compile
endef

define Package/luci-app-rrws/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./root/usr/bin/wregister.sh $(1)/usr/bin/
	$(INSTALL_BIN) ./root/usr/bin/wscan.sh $(1)/usr/bin/
	$(INSTALL_BIN) ./root/usr/bin/wsspeed.sh $(1)/usr/bin/

	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/rrws.json $(1)/usr/share/luci/menu.d/

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-rrws.json $(1)/usr/share/rpcd/acl.d/

	$(INSTALL_DIR) $(1)/usr/share/rpcd/ucode
	$(INSTALL_DATA) ./root/usr/share/rpcd/ucode/luci.rrws $(1)/usr/share/rpcd/ucode/

	$(INSTALL_DIR) $(1)/lib/upgrade/keep.d
	$(INSTALL_DATA) ./root/lib/upgrade/keep.d/luci-app-rrws $(1)/lib/upgrade/keep.d/

	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/rrws
	$(INSTALL_DATA) ./root/www/luci-static/resources/view/rrws/scan.js $(1)/www/luci-static/resources/view/rrws/
endef

$(eval $(call BuildPackage,luci-app-rrws))
