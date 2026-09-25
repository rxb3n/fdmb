(function () {
    var findByProps = vendetta.metro.findByProps;
    var instead = vendetta.patcher.instead;
    var before = vendetta.patcher.before;

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

    var patches = [];

    return {
        onLoad: function () {
            console.log("[FileditchMobile] onLoad called");

            var FileUtils = findByProps("maxFileSize", "makeFile");
            var PremiumUtils = findByProps("getUserMaxFileSize");
            console.log("[FileditchMobile] FileUtils found:", !!FileUtils, "PremiumUtils found:", !!PremiumUtils);

            if (FileUtils && typeof FileUtils.maxFileSize === "function") {
                patches.push(
                    instead("maxFileSize", FileUtils, function () {
                        console.log("[FileditchMobile] maxFileSize() called, returning R2_SIZE_LIMIT");
                        return R2_SIZE_LIMIT;
                    })
                );
                console.log("[FileditchMobile] Patched FileUtils.maxFileSize");
            }

            if (PremiumUtils && typeof PremiumUtils.getUserMaxFileSize === "function") {
                patches.push(
                    instead("getUserMaxFileSize", PremiumUtils, function () {
                        console.log("[FileditchMobile] getUserMaxFileSize() called, returning R2_SIZE_LIMIT");
                        return R2_SIZE_LIMIT;
                    })
                );
                console.log("[FileditchMobile] Patched PremiumUtils.getUserMaxFileSize");
            }

            var MessageSender = findByProps("sendMessage", "editMessage");
            console.log("[FileditchMobile] MessageSender found:", !!MessageSender);
            if (!MessageSender) {
                console.error("[FileditchMobile] Could not locate MessageSender module");
                return;
            }

            patches.push(
                before("sendMessage", MessageSender, function (args) {
                    try {
                        var channelId = args[0];
                        var message = args[1];
                        var files = (message && (message.files || message.attachments)) || [];
                        console.log("[FileditchMobile] sendMessage before-hook. files=" + files.length);
                        if (!Array.isArray(files) || files.length === 0) return;

                        var largeFiles = files.filter(function (f) {
                            var size = f.size || f.fileSize || f.currentSize || 0;
                            return size > DISCORD_SIZE_LIMIT;
                        });
                        console.log("[FileditchMobile] largeFiles.length=" + largeFiles.length);
                        if (largeFiles.length === 0) return;

                        if (message.files) {
                            message.files = message.files.filter(function (f) {
                                var size = f.size || f.fileSize || f.currentSize || 0;
                                return size <= DISCORD_SIZE_LIMIT;
                            });
                        }
                        if (message.attachments) {
                            message.attachments = message.attachments.filter(function (f) {
                                var size = f.size || f.fileSize || f.currentSize || 0;
                                return size <= DISCORD_SIZE_LIMIT;
                            });
                        }

                        largeFiles.forEach(function (file) {
                            var fileSize = file.size || file.fileSize || file.currentSize || 0;
                            if (fileSize > R2_SIZE_LIMIT) {
                                console.log("[FileditchMobile] File exceeds R2 limit, skipping: " + fileSize);
                                return;
                            }

                            var filename = file.name || file.filename || "upload.mp4";
                            var mimeType = file.type || file.mimeType || "application/octet-stream";
                            var uri = file.uri || file.url;

                            console.log("[FileditchMobile] Uploading to R2: " + filename + " (" + fileSize + " bytes)");

                            uploadToR2(uri, filename, mimeType).then(function (publicUrl) {
                                console.log("[FileditchMobile] R2 upload success: " + publicUrl);
                                var extParts = filename.split(".");
                                var ext = extParts.length > 1 ? extParts.pop().toLowerCase() : "";
                                var isVideo = mimeType.indexOf("video/") === 0 || !!VIDEO_EXTENSIONS[ext];
                                var content = isVideo ? ("[\u2800](" + publicUrl + ")") : publicUrl;

                                MessageSender.sendMessage(channelId, { content: content });
                            }).catch(function (err) {
                                console.error("[FileditchMobile] Failed to upload large file:", err);
                            });
                        });
                    } catch (err) {
                        console.error("[FileditchMobile] sendMessage hook error:", err);
                    }
                })
            );
            console.log("[FileditchMobile] Patched sendMessage");
        },
        onUnload: function () {
            for (var i = 0; i < patches.length; i++) patches[i]();
            patches = [];
        }
    };
})()
