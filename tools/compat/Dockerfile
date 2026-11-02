# Test image: a real GNOME Shell of a given Fedora release, run headless.
#   docker build --build-arg FEDORA=41 -t cas-gnome:f41 tools/compat
ARG FEDORA=41
FROM fedora:${FEDORA}
RUN dnf -y --setopt=install_weak_deps=False install \
        gnome-shell gjs glib2 libsoup3 dbus-daemon dbus-tools mesa-dri-drivers \
        python3 unzip procps-ng util-linux xorg-x11-server-Xwayland gsettings-desktop-schemas \
        adwaita-icon-theme \
    && dnf clean all
# SVG image loaders (spinners, icons); glycin is used by newer GNOME releases
RUN dnf -y --setopt=install_weak_deps=False install librsvg2 \
    && (dnf -y --setopt=install_weak_deps=False install glycin-loaders || true) \
    && dnf clean all
RUN useradd -m tester
USER tester
