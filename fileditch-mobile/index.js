(function () {
    var findByProps = vendetta.metro.findByProps;
    var instead = vendetta.patcher.instead;

    var DISCORD_SIZE_LIMIT = 20 * 1024 * 1024;
    var R2_SIZE_LIMIT = 5 * 1024 * 1024 * 1024;
    var VIDEO_EXTENSIONS = { mp4: 1, webm: 1, mov: 1, mkv: 1, avi: 1, m4v: 1, flv: 1, wmv: 1 };
    var UPLOAD_API_URL = "https://fileditch.vercel.app/api/upload-ticket";

    function fetchUploadTicket(filename, mimeType) {
        var url = new URL(UPLOAD_API_URL);
        url.searchParams.set("filename", filename);
        url.searchParams.set("mimeType", mimeType);
        return fetch(url.toString()).then(function (res) {
            if (!res.ok) throw new Error("Ticket API failed with status " + res.status);
            return res.json();
        });
    }

    function uploadToR2(uri, filename, mimeType) {
        return fetchUploadTicket(filename, mimeType).then(function (ticket) {
            return fetch(uri).then(function (fileRes) {
                return fileRes.blob().then(function (blob) {
                    return fetch(ticket.uploadUrl, {
                        method: "PUT",
                        headers: {
                            "Content-Type": mimeType || "application/octet-stream",
                            "Content-Disposition": "inline"
                        },
                        body: blob
                    }).then(function (putRes) {
                        if (!putRes.ok) throw new Error("R2 upload failed with status " + putRes.status);
                        return ticket.publicUrl;
                    });
                });
            });
        });
    }

    function sendMessageAggressive(channelId, content) {
        var TokenStore = findByProps("getToken");
        var token = TokenStore && TokenStore.getToken && TokenStore.getToken();
        if (!token) {
            console.error("[FileditchMobile] No token available for REST fallback");
            return Promise.reject(new Error("No token"));
        }
        return fetch("https://discord.com/api/v9/channels/" + channelId + "/messages", {
            method: "POST",
            headers: { "Authorization": token, "Content-Type": "application/json" },
            body: JSON.stringify({
                content: content,
                nonce: Math.floor(Math.random() * 1000000000000000).toString()
            })
        }).then(function (res) {
            if (!res.ok) {
                return res.text().then(function (t) {
                    throw new Error("sendMessage REST failed: " + res.status + " " + t);
                });
            }
            return res.json();
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

                    uploadToR2(uri, filename, mimeType).then(function (publicUrl) {
                        console.log("[FileditchMobile] R2 upload success: " + publicUrl);
                        var extParts = filename.split(".");
                        var ext = extParts.length > 1 ? extParts.pop().toLowerCase() : "";
                        var isVideo = mimeType.indexOf("video/") === 0 || !!VIDEO_EXTENSIONS[ext];
                        var content = isVideo ? ("[\u2800](" + publicUrl + ")") : publicUrl;

                        return sendMessageAggressive(channelId, content);
                    }).then(function () {
                        console.log("[FileditchMobile] Follow-up message sent successfully");
                    }).catch(function (err) {
                        console.error("[FileditchMobile] Failed to upload/send large file:", err);
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
