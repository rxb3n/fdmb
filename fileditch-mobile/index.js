(function () {
    var findByProps = vendetta.metro.findByProps;
    var instead = vendetta.patcher.instead;

    var DISCORD_SIZE_LIMIT = 20 * 1024 * 1024;
    var R2_SIZE_LIMIT = 5 * 1024 * 1024 * 1024;
    var VIDEO_EXTENSIONS = { mp4: 1, webm: 1, mov: 1, mkv: 1, avi: 1, m4v: 1, flv: 1, wmv: 1 };
    var UPLOAD_API_URL = "https://fileditch.vercel.app/api/upload-ticket";

    function getToken() {
        var TokenStore = findByProps("getToken");
        return TokenStore && TokenStore.getToken && TokenStore.getToken();
    }

    function restRequest(method, path, body) {
        var token = getToken();
        if (!token) return Promise.reject(new Error("No token"));
        return fetch("https://discord.com/api/v9" + path, {
            method: method,
            headers: { "Authorization": token, "Content-Type": "application/json" },
            body: body ? JSON.stringify(body) : undefined
        }).then(function (res) {
            if (!res.ok) {
                return res.text().then(function (t) {
                    throw new Error(method + " " + path + " failed: " + res.status + " " + t);
                });
            }
            return res.json();
        });
    }

    function sendMessageAggressive(channelId, content) {
        return restRequest("POST", "/channels/" + channelId + "/messages", {
            content: content,
            nonce: Math.floor(Math.random() * 1000000000000000).toString()
        });
    }

    function editMessageAggressive(channelId, messageId, content) {
        return restRequest("PATCH", "/channels/" + channelId + "/messages/" + messageId, {
            content: content
        });
    }

    function formatBytes(n) {
        if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
        if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
        if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
        return n + " B";
    }

    function progressBar(pct) {
        var totalBars = 12;
        var filled = Math.round((pct / 100) * totalBars);
        if (filled < 0) filled = 0;
        if (filled > totalBars) filled = totalBars;
        return "[" + new Array(filled + 1).join("\u2588") + new Array(totalBars - filled + 1).join("\u2591") + "]";
    }

    function fetchUploadTicket(filename, mimeType) {
        var url = new URL(UPLOAD_API_URL);
        url.searchParams.set("filename", filename);
        url.searchParams.set("mimeType", mimeType);
        return fetch(url.toString()).then(function (res) {
            if (!res.ok) throw new Error("Ticket API failed with status " + res.status);
            return res.json();
        });
    }

    function putWithProgress(url, headers, blob, onProgress) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open("PUT", url, true);
            for (var key in headers) {
                if (headers.hasOwnProperty(key)) xhr.setRequestHeader(key, headers[key]);
            }
            xhr.upload.onprogress = function (e) {
                if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
            };
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) resolve();
                else reject(new Error("R2 upload failed with status " + xhr.status));
            };
            xhr.onerror = function () { reject(new Error("R2 upload network error")); };
            xhr.send(blob);
        });
    }

    function uploadToR2WithProgress(uri, filename, mimeType, onProgress) {
        return fetchUploadTicket(filename, mimeType).then(function (ticket) {
            return fetch(uri).then(function (fileRes) {
                return fileRes.blob().then(function (blob) {
                    return putWithProgress(
                        ticket.uploadUrl,
                        { "Content-Type": mimeType || "application/octet-stream", "Content-Disposition": "inline" },
                        blob,
                        onProgress
                    ).then(function () {
                        return ticket.publicUrl;
                    });
                });
            });
        });
    }

    var patches = [];

    return {
        onLoad: function () {
            console.log("[FileditchMobile] onLoad called");

            var FileUtils = findByProps("maxFileSize", "makeFile");
            var PremiumUtils = findByProps("getUserMaxFileSize");

            if (FileUtils && typeof FileUtils.maxFileSize === "function") {
                patches.push(instead("maxFileSize", FileUtils, function () { return R2_SIZE_LIMIT; }));
            }
            if (PremiumUtils && typeof PremiumUtils.getUserMaxFileSize === "function") {
                patches.push(instead("getUserMaxFileSize", PremiumUtils, function () { return R2_SIZE_LIMIT; }));
            }

            var CloudUploadModule = findByProps("CloudUpload");
            var CloudUpload = CloudUploadModule && CloudUploadModule.CloudUpload;
            console.log("[FileditchMobile] CloudUpload found:", !!CloudUpload);

            if (CloudUpload && CloudUpload.prototype && CloudUpload.prototype.reactNativeCompressAndExtractData) {
                var originalCompress = CloudUpload.prototype.reactNativeCompressAndExtractData;
                console.log("[FileditchMobile] Patching CloudUpload.prototype.reactNativeCompressAndExtractData");

                CloudUpload.prototype.reactNativeCompressAndExtractData = function () {
                    var file = this;
                    var size = file.currentSize || file.preCompressionSize || 0;
                    console.log("[FileditchMobile] compress called. size=" + size + " filename=" + file.filename);

                    if (size <= DISCORD_SIZE_LIMIT || size > R2_SIZE_LIMIT) {
                        return originalCompress.apply(file, arguments);
                    }

                    var filename = file.filename || "upload";
                    var mimeType = file.mimeType || "application/octet-stream";
                    var uri = (file.item && file.item.uri) || file.uri;
                    var channelId = file.channelId;

                    console.log("[FileditchMobile] Redirecting oversized file to R2: " + filename + " (" + size + " bytes), uri=" + uri);

                    var statusMessageId = null;
                    var lastEditTime = 0;

                    sendMessageAggressive(channelId, "\u23F3 Uploading **" + filename + "** (" + formatBytes(size) + ")...\n" + progressBar(0) + " 0%")
                        .then(function (msg) {
                            statusMessageId = msg && msg.id;

                            return uploadToR2WithProgress(uri, filename, mimeType, function (loaded, total) {
                                var now = Date.now();
                                if (!statusMessageId || now - lastEditTime < 1500) return;
                                lastEditTime = now;
                                var pct = Math.floor((loaded / total) * 100);
                                editMessageAggressive(
                                    channelId,
                                    statusMessageId,
                                    "\u23F3 Uploading **" + filename + "** (" + formatBytes(loaded) + " / " + formatBytes(total) + ")...\n" + progressBar(pct) + " " + pct + "%"
                                ).catch(function (err) {
                                    console.error("[FileditchMobile] Progress edit failed:", err);
                                });
                            });
                        })
                        .then(function (publicUrl) {
                            console.log("[FileditchMobile] R2 upload success: " + publicUrl);
                            var extParts = filename.split(".");
                            var ext = extParts.length > 1 ? extParts.pop().toLowerCase() : "";
                            var isVideo = mimeType.indexOf("video/") === 0 || !!VIDEO_EXTENSIONS[ext];
                            var finalContent = isVideo ? ("[\u2800](" + publicUrl + ")") : publicUrl;

                            if (statusMessageId) {
                                return editMessageAggressive(channelId, statusMessageId, finalContent);
                            }
                            return sendMessageAggressive(channelId, finalContent);
                        })
                        .then(function () {
                            console.log("[FileditchMobile] Upload flow complete");
                        })
                        .catch(function (err) {
                            console.error("[FileditchMobile] Failed to upload/send large file:", err);
                            if (statusMessageId) {
                                editMessageAggressive(channelId, statusMessageId, "\u274C Upload of **" + filename + "** failed: " + (err && err.message)).catch(function () {});
                            }
                        });

                    try { file.status = "CANCELED"; } catch (e) {}
                    return Promise.reject(new Error("[FileditchMobile] Redirected to R2, skipping native upload"));
                };

                patches.push(function () {
                    CloudUpload.prototype.reactNativeCompressAndExtractData = originalCompress;
                });
            } else {
                console.log("[FileditchMobile] CloudUpload.prototype.reactNativeCompressAndExtractData not found, patch NOT applied");
            }
        },
        onUnload: function () {
            for (var i = 0; i < patches.length; i++) {
                try { patches[i](); } catch (e) {}
            }
            patches = [];
        }
    };
})()
