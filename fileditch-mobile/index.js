const { findByProps } = vendetta.metro;
const { instead } = vendetta.patcher;

const DISCORD_SIZE_LIMIT = 20 * 1024 * 1024; // 20 MB Discord default
const R2_SIZE_LIMIT = 5 * 1024 * 1024 * 1024; // 5 GB R2 limit
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v", "flv", "wmv"]);
const UPLOAD_API_URL = "https://fileditch.vercel.app/api/upload-ticket";

async function fetchUploadTicket(filename, mimeType) {
    const url = new URL(UPLOAD_API_URL);
    url.searchParams.set("filename", filename);
    url.searchParams.set("mimeType", mimeType);

    const res = await fetch(url.toString());
    if (!res.ok) {
        throw new Error("Ticket API failed with status " + res.status);
    }
    return await res.json();
}

async function uploadToR2(uri, filename, mimeType) {
    const ticket = await fetchUploadTicket(filename, mimeType);

    const fileRes = await fetch(uri);
    const blob = await fileRes.blob();

    const putRes = await fetch(ticket.uploadUrl, {
        method: "PUT",
        headers: {
            "Content-Type": mimeType || "application/octet-stream",
            "Content-Disposition": "inline"
        },
        body: blob
    });

    if (!putRes.ok) {
        throw new Error("R2 upload failed with status " + putRes.status);
    }

    return ticket.publicUrl;
}

var patches = [];

module.exports = {
    onLoad: function () {
        var Messages = findByProps("sendMessage", "uploadFiles");
        if (!Messages) {
            console.error("[FileditchMobile] Could not locate Messages module");
            return;
        }

        if (typeof Messages.uploadFiles === "function") {
            patches.push(
                instead("uploadFiles", Messages, function (args, orig) {
                    return (async () => {
                        var channelId = args[0];
                        var parsedMessage = args[1];
                        var files = args[2];
                        if (!Array.isArray(files) || files.length === 0) {
                            return orig.apply(null, args);
                        }

                        var largeFiles = files.filter(function (f) {
                            return (f.size || f.fileSize || 0) > DISCORD_SIZE_LIMIT;
                        });
                        if (largeFiles.length === 0) {
                            return orig.apply(null, args);
                        }

                        var normalFiles = files.filter(function (f) {
                            return (f.size || f.fileSize || 0) <= DISCORD_SIZE_LIMIT;
                        });

                        for (var i = 0; i < largeFiles.length; i++) {
                            var file = largeFiles[i];
                            var fileSize = file.size || file.fileSize || 0;
                            if (fileSize > R2_SIZE_LIMIT) {
                                continue;
                            }

                            try {
                                var filename = file.name || file.filename || "upload.mp4";
                                var mimeType = file.type || file.mimeType || "application/octet-stream";
                                var uri = file.uri || file.url;

                                var publicUrl = await uploadToR2(uri, filename, mimeType);
                                var extParts = filename.split(".");
                                var ext = extParts.length > 1 ? extParts.pop().toLowerCase() : "";
                                var isVideo = mimeType.indexOf("video/") === 0 || VIDEO_EXTENSIONS.has(ext);

                                var content = isVideo ? ("[\u2800](" + publicUrl + ")") : publicUrl;

                                await Messages.sendMessage(channelId, {
                                    content: content
                                });
                            } catch (err) {
                                console.error("[FileditchMobile] Failed to upload large file:", err);
                            }
                        }

                        if (normalFiles.length > 0) {
                            return orig(channelId, parsedMessage, normalFiles);
                        }
                    })();
                })
            );
        }
    },
    onUnload: function () {
        for (var i = 0; i < patches.length; i++) patches[i]();
        patches = [];
    }
};
