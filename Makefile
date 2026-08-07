# luci-app-warpscan Makefile for OpenWrt
# Build with SDK: make package/luci-app-warpscan/compile

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-warpscan
PKG_VERSION:=1.0
PKG_RELEASE:=1

PKG_LICENSE:=Apache-2.0
PKG_LICENSE_FILES:=
PKG_MAINTAINER:=Warpscan <dev@example.org>

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-warpscan
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=WARP endpoint scanner for AmneziaWG
  URL:=https://example.org/luci-app-warpscan
  PKGARCH:=all
  DEPENDS:=+amneziawg-tools +jq +curl +luci-base +rpcd-mod-ucode
endef

define Package/luci-app-warpscan/description
  Scan Cloudflare WARP endpoints via kernel AmneziaWG,
  pick the best and import it into the warp interface.
  Provides a LuCI page under Network -> WARP Scanner.
endef

define Package/luci-app-warpscan/postinst
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
/etc/init.d/rpcd restart >/dev/null 2>&1
rm -f /tmp/luci-indexcache* /tmp/luci-modulecache 2>/dev/null
exit 0
endef

define Package/luci-app-warpscan/postrm
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
/etc/init.d/rpcd restart >/dev/null 2>&1
rm -f /tmp/luci-indexcache* /tmp/luci-modulecache 2>/dev/null
exit 0
endef

define Build/Prepare
endef

define Build/Compile
endef

define Package/luci-app-warpscan/install
	$(INSTALL_DIR) $(1)/usr/libexec/warpscan
	$(INSTALL_BIN) ./root/usr/libexec/warpscan/wregister.sh $(1)/usr/libexec/warpscan/
	$(INSTALL_BIN) ./root/usr/libexec/warpscan/wscan.sh $(1)/usr/libexec/warpscan/

	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/warpscan.json $(1)/usr/share/luci/menu.d/

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-warpscan.json $(1)/usr/share/rpcd/acl.d/

	$(INSTALL_DIR) $(1)/usr/share/rpcd/ucode
	$(INSTALL_DATA) ./root/usr/share/rpcd/ucode/luci.warpscan $(1)/usr/share/rpcd/ucode/

	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/warpscan
	$(INSTALL_DATA) ./root/www/luci-static/resources/view/warpscan/scan.js $(1)/www/luci-static/resources/view/warpscan/
endef

$(eval $(call BuildPackage,luci-app-warpscan))
