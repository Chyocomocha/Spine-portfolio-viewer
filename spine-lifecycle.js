(function () {
    if (!window.spine || !window.spine.SpinePlayer || window.spine.SpinePlayer.__lifecycleManaged) {
        return;
    }

    var spineNamespace = window.spine;
    var OriginalSpinePlayer = spineNamespace.SpinePlayer;
    var LOAD_DELAY = 180;
    var DISPOSE_DELAY = 80;
    var RETRY_DELAY = 800;
    var MIN_VISIBLE_RATIO = 0.01;
    var MIN_VISIBLE_PIXELS = 120;

    function ManagedSpinePlayer(elementOrId, config) {
        var manager = this;
        var container = typeof elementOrId === "string" ? document.getElementById(elementOrId) : elementOrId;
        var originalConfig = config || {};
        var realPlayer = null;
        var isVisible = false;
        var isLoading = false;
        var isDisposed = false;
        var disposeAfterLoad = false;
        var loadTimer = null;
        var disposeTimer = null;
        var retryTimer = null;
        var observer = null;
        var isReleasingContext = false;

        manager.player = null;

        function clearTimer(timer) {
            if (timer) window.clearTimeout(timer);
            return null;
        }

        function clearContainer() {
            if (!container) return;
            releaseCanvasContexts();
            try {
                container.replaceChildren();
            } catch (e) {
                container.innerHTML = "";
            }
        }

        function releaseCanvasContexts() {
            if (!container) return;

            var canvases = container.querySelectorAll("canvas");
            canvases.forEach(function (canvas) {
                var gl = null;
                try {
                    gl = canvas.getContext("webgl")
                        || canvas.getContext("webgl2")
                        || canvas.getContext("experimental-webgl");
                } catch (e) {
                    gl = null;
                }

                if (!gl) return;

                var loseContext = null;
                try {
                    loseContext = gl.getExtension("WEBGL_lose_context");
                } catch (e) {
                    loseContext = null;
                }

                if (loseContext && typeof loseContext.loseContext === "function") {
                    try {
                        isReleasingContext = true;
                        loseContext.loseContext();
                    } catch (e) {
                        // Context release is best-effort; DOM cleanup still follows.
                    } finally {
                        window.setTimeout(function () {
                            isReleasingContext = false;
                        }, 0);
                    }
                }
            });
        }

        function destroyPlayer() {
            loadTimer = clearTimer(loadTimer);
            retryTimer = clearTimer(retryTimer);

            if (isLoading && !realPlayer) {
                disposeAfterLoad = true;
                return;
            }

            isLoading = false;
            disposeAfterLoad = false;

            if (realPlayer && typeof realPlayer.dispose === "function") {
                try {
                    isReleasingContext = true;
                    releaseCanvasContexts();
                    realPlayer.dispose();
                } catch (e) {
                    console.warn("Spine player dispose failed:", e);
                } finally {
                    window.setTimeout(function () {
                        isReleasingContext = false;
                    }, 0);
                }
            }

            realPlayer = null;
            manager.player = null;
            clearContainer();
        }

        function scheduleRetry() {
            retryTimer = clearTimer(retryTimer);
            if (!isVisible || isDisposed) return;
            retryTimer = window.setTimeout(function () {
                if (isVisible && !realPlayer && !isLoading && !isDisposed) {
                    createPlayer();
                }
            }, RETRY_DELAY);
        }

        function createPlayer() {
            if (!container || isDisposed || !isVisible || realPlayer || isLoading) return;

            isLoading = true;
            disposeAfterLoad = false;

            var managedConfig = {};
            Object.keys(originalConfig).forEach(function (key) {
                managedConfig[key] = originalConfig[key];
            });

            managedConfig.success = function (player) {
                isLoading = false;
                realPlayer = player;
                manager.player = player;
                disposeAfterLoad = false;

                if (!isVisible || isDisposed) {
                    disposeTimer = clearTimer(disposeTimer);
                    disposeTimer = window.setTimeout(destroyPlayer, 0);
                    return;
                }

                if (typeof originalConfig.success === "function") {
                    originalConfig.success(player);
                }
            };

            managedConfig.error = function (player, error) {
                var wasWaitingForDispose = disposeAfterLoad;
                isLoading = false;
                disposeAfterLoad = false;

                if (wasWaitingForDispose) {
                    clearContainer();
                    if (isVisible && !isDisposed) {
                        scheduleRetry();
                    }
                    return;
                }

                if (!isVisible || isDisposed) {
                    clearContainer();
                    return;
                }

                if (typeof originalConfig.error === "function") {
                    originalConfig.error(player, error);
                } else {
                    console.error("Spine player error:", error);
                }

                if (isVisible && !isDisposed) {
                    scheduleRetry();
                }
            };

            try {
                clearContainer();
                new OriginalSpinePlayer(elementOrId, managedConfig);
            } catch (e) {
                isLoading = false;
                disposeAfterLoad = false;
                if (typeof originalConfig.error === "function") {
                    originalConfig.error(null, e);
                } else {
                    console.error("Spine player create failed:", e);
                }
                scheduleRetry();
            }
        }

        function scheduleLoad() {
            disposeTimer = clearTimer(disposeTimer);
            loadTimer = clearTimer(loadTimer);
            if (realPlayer || isLoading || isDisposed) return;
            loadTimer = window.setTimeout(createPlayer, LOAD_DELAY);
        }

        function scheduleDispose() {
            loadTimer = clearTimer(loadTimer);
            retryTimer = clearTimer(retryTimer);
            disposeTimer = clearTimer(disposeTimer);
            disposeTimer = window.setTimeout(destroyPlayer, DISPOSE_DELAY);
        }

        function setVisible(nextVisible) {
            isVisible = Boolean(nextVisible);
            if (isVisible && document.visibilityState !== "hidden") {
                scheduleLoad();
            } else {
                scheduleDispose();
            }
        }

        manager.dispose = function () {
            isDisposed = true;
            loadTimer = clearTimer(loadTimer);
            disposeTimer = clearTimer(disposeTimer);
            retryTimer = clearTimer(retryTimer);
            if (observer) observer.disconnect();
            isLoading = false;
            disposeAfterLoad = false;
            destroyPlayer();
        };

        manager.reload = function () {
            destroyPlayer();
            if (isVisible && document.visibilityState !== "hidden") {
                scheduleLoad();
            }
        };

        if (!container || typeof IntersectionObserver === "undefined") {
            isVisible = true;
            scheduleLoad();
        } else {
            observer = new IntersectionObserver(function (entries) {
                var entry = entries[0];
                var visiblePixels = entry && entry.intersectionRect ? entry.intersectionRect.height : 0;
                setVisible(entry && entry.isIntersecting && (
                    entry.intersectionRatio >= MIN_VISIBLE_RATIO || visiblePixels >= MIN_VISIBLE_PIXELS
                ));
            }, { threshold: [0, 0.01, 0.1] });
            observer.observe(document.body);
        }

        document.addEventListener("visibilitychange", function () {
            if (document.visibilityState === "hidden") {
                scheduleDispose();
            } else if (isVisible) {
                scheduleLoad();
            }
        });

        window.addEventListener("pagehide", manager.dispose);
        window.addEventListener("beforeunload", manager.dispose);

        if (container) {
            container.addEventListener("webglcontextlost", function (event) {
                if (isReleasingContext) return;
                event.preventDefault();
                destroyPlayer();
                scheduleRetry();
            }, true);
        }
    }

    ManagedSpinePlayer.__lifecycleManaged = true;
    ManagedSpinePlayer.OriginalSpinePlayer = OriginalSpinePlayer;

    try {
        spineNamespace.SpinePlayer = ManagedSpinePlayer;
    } catch (e) {
        // Some Spine builds expose SpinePlayer as a getter-only property.
    }

    if (spineNamespace.SpinePlayer !== ManagedSpinePlayer) {
        var proxiedSpine = Object.create(spineNamespace);
        Object.defineProperty(proxiedSpine, "SpinePlayer", {
            value: ManagedSpinePlayer,
            enumerable: true,
            configurable: true,
            writable: true
        });
        proxiedSpine.__originalSpineNamespace = spineNamespace;
        window.spine = proxiedSpine;
    }
})();
