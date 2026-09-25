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
            if (!res.ok) {
                throw new Error("Ticket API failed with status " + res.status);
            }
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
                        if (!putRes.ok) {
                            throw new Error("R2 upload failed with status " + putRes.status);
                        }
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
            var Messages = findByProps("sendMessage", "uploadFiles");
            console.log("[FileditchMobile] Messages module found:", !!Messages);
            if (!Messages) {
                console.error("[FileditchMobile] Could not locate Messages module");
                return;
            }

            console.log("[FileditchMobile] Messages.uploadFiles type:", typeof Messages.uploadFiles);

            if (typeof Messages.uploadFiles === "function") {
                console.log("[FileditchMobile] Patching uploadFiles...");
                patches.push(
                    instead("uploadFiles", Messages, function (args, orig) {
                        try {
                            var dbgFiles = Array.isArray(args[2]) ? args[2].map(function (f) {
                                return { name: f.name || f.filename, size: f.size || f.fileSize };
                            }) : [];
                            console.log("[FileditchMobile] uploadFiles intercepted. channelId=" + args[0] + " files=" + JSON.stringify(dbgFiles));
                        } catch (logErr) {
                            console.log("[FileditchMobile] uploadFiles intercepted (log failed): " + logErr);
                        }

                        var channelId = args[0];
                        var parsedMessage = args[1];
                        var files = args[2];
                        if (!Array.isArray(files) || files.length === 0) {
                            console.log("[FileditchMobile] No files array, passing through to orig");
                            return orig.apply(null, args);
                        }

                        var largeFiles = files.filter(function (f) {
                            return (f.size || f.fileSize || 0) > DISCORD_SIZE_LIMIT;
                        });
                        console.log("[FileditchMobile] largeFiles.length=" + largeFiles.length);
                        if (largeFiles.length === 0) {
                            return orig.apply(null, args);
                        }

                        var normalFiles = files.filter(function (f) {
                            return (f.size || f.fileSize || 0) <= DISCORD_SIZE_LIMIT;
                        });

                        var chain = Promise.resolve();
                        largeFiles.forEach(function (file) {
                            chain = chain.then(function () {
                                var fileSize = file.size || file.fileSize || 0;
                                if (fileSize > R2_SIZE_LIMIT) {
                                    console.log("[FileditchMobile] File exceeds R2 limit, skipping: " + fileSize);
                                    return;
                                }

                                var filename = file.name || file.filename || "upload.mp4";
                                var mimeType = file.type || file.mimeType || "application/octet-stream";
                                var uri = file.uri || file.url;

                                console.log("[FileditchMobile] Uploading to R2: " + filename + " (" + fileSize + " bytes)");

                                return uploadToR2(uri, filename, mimeType).then(function (publicUrl) {
                                    console.log("[FileditchMobile] R2 upload success: " + publicUrl);
                                    var extParts = filename.split(".");
                                    var ext = extParts.length > 1 ? extParts.pop().toLowerCase() : "";
                                    var isVideo = mimeType.indexOf("video/") === 0 || !!VIDEO_EXTENSIONS[ext];

                                    var content = isVideo ? ("[\u2800](" + publicUrl + ")") : publicUrl;

                                    return Messages.sendMessage(channelId, { content: content });
                                }).catch(function (err) {
                                    console.error("[FileditchMobile] Failed to upload large file:", err);
                                });
                            });
                        });

                        return chain.then(function () {
                            if (normalFiles.length > 0) {
                                console.log("[FileditchMobile] Sending " + normalFiles.length + " normal file(s) via orig");
                                return orig(channelId, parsedMessage, normalFiles);
                            }
                        });
                    })
                );
                console.log("[FileditchMobile] Patch applied successfully");
            } else {
                console.log("[FileditchMobile] uploadFiles is not a function, patch NOT applied");
            }
        },
        onUnload: function () {
            for (var i = 0; i < patches.length; i++) patches[i]();
            patches = [];
        }
    };
})()
