export function isMobileRuntime(target = globalThis) {
    const nav = target?.navigator || {};
    const ua = String(nav.userAgent || '');
    const isElectron = !!(target?.window?.desktop && target.window.desktop.isElectron) || /electron/i.test(ua);
    if (isElectron) return false;

    const isCapacitor = (() => {
        try {
            return !!(target?.window?.Capacitor || target?.Capacitor);
        } catch (_) {
            return false;
        }
    })();

    const uaMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    return isCapacitor || uaMobile;
}
