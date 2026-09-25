import { findByProps } from "@revenge-mod/modules/finders";
import { instead } from "@revenge-mod/patcher";

const DISCORD_SIZE_LIMIT = 20 * 1024 * 1024; // 20 MB Discord default
const R2_SIZE_LIMIT = 5 * 1024 * 1024 * 1024; // 5 GB R2 limit
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v", "flv", "wmv"]);
const UPLOAD_API_URL = "https://fileditch.vercel.app/api/upload-ticket";

interface TicketResponse {
    uploadUrl: string;
    publicUrl: string;
}

async function fetchUploadTicket(filename: string, mimeType: string): Promise<TicketResponse> {
    const url = new URL(UPLOAD_API_URL);
    url.searchParams.set("filename", filename);
    url.searchParams.set("mimeType", mimeType);

    const res = await fetch(url.toString());
    if (!res.ok) {
        throw new Error(`Ticket API failed with status ${res.status}`);
    }
    return await res.json();
}

async function uploadToR2(uri: string, filename: string, mimeType: string): Promise<string> {
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
        throw new Error(`R2 upload failed with status ${putRes.status}`);
    }

    return ticket.publicUrl;
}

export default plugin({
    start({ cleanup }) {
        const Messages = findByProps("sendMessage", "uploadFiles");
        if (!Messages) {
            console.error("[FileditchMobile] Could not locate Messages module");
            return;
        }

        if (typeof Messages.uploadFiles === "function") {
            cleanup(
                instead("uploadFiles", Messages, async (args, orig) => {
                    const [channelId, parsedMessage, files] = args;
                    if (!Array.isArray(files) || files.length === 0) {
                        return orig(...args);
                    }

                    const largeFiles = files.filter((f: any) => (f.size ?? f.fileSize ?? 0) > DISCORD_SIZE_LIMIT);
                    if (largeFiles.length === 0) {
                        return orig(...args);
                    }

                    const normalFiles = files.filter((f: any) => (f.size ?? f.fileSize ?? 0) <= DISCORD_SIZE_LIMIT);

                    for (const file of largeFiles) {
                        const fileSize = file.size ?? file.fileSize ?? 0;
                        if (fileSize > R2_SIZE_LIMIT) {
                            continue;
                        }

                        try {
                            const filename = file.name ?? file.filename ?? "upload.mp4";
                            const mimeType = file.type ?? file.mimeType ?? "application/octet-stream";
                            const uri = file.uri ?? file.url;

                            const publicUrl = await uploadToR2(uri, filename, mimeType);
                            const ext = filename.split(".").pop()?.toLowerCase() ?? "";
                            const isVideo = mimeType.startsWith("video/") || VIDEO_EXTENSIONS.has(ext);

                            const content = isVideo ? `[\u2800](${publicUrl})` : publicUrl;

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
                })
            );
        }
    }
});
