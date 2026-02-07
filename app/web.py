from __future__ import annotations

import json
import mimetypes
import re
import secrets
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .chat_manager import ChatManager
from .config import MAX_HISTORY_MESSAGES, MAX_UPLOAD_BYTES, STATIC_DIR, TEMPLATES_DIR, UPLOAD_DIR
from .models import Attachment


def _normalize_ip(ip: str | None) -> str:
    raw = (ip or "unknown").strip()
    if not raw:
        return "unknown"
    if raw.startswith("::ffff:"):
        return raw.split("::ffff:", maxsplit=1)[1]
    return raw


def _normalize_optional_ip(ip: str | None) -> str | None:
    if ip is None:
        return None
    normalized = _normalize_ip(ip)
    if normalized == "unknown":
        return None
    return normalized


def _normalize_device_id(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip().lower()
    if not cleaned:
        return None
    if len(cleaned) > 80:
        return None
    if not re.fullmatch(r"[a-z0-9:._-]+", cleaned):
        return None
    return cleaned


def _normalize_device_name(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = re.sub(r"\s+", " ", str(value).strip())
    if not cleaned:
        return None
    if len(cleaned) > 64:
        cleaned = cleaned[:64]
    return cleaned


def _pick_client_id(request_ip: str, provided_id: str | None) -> str:
    device_id = _normalize_device_id(provided_id)
    if device_id:
        return device_id
    # Backward compatibility for old clients that do not send device id.
    return f"ip-{request_ip}"


def _normalize_recipient_id(value: str | None) -> str | None:
    device_id = _normalize_device_id(value)
    if device_id:
        return device_id
    legacy_ip = _normalize_optional_ip(value)
    if legacy_ip:
        return f"ip-{legacy_ip}"
    return None


def _client_ip_from_request(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return _normalize_ip(forwarded.split(",")[0])
    client_host = request.client.host if request.client else "unknown"
    return _normalize_ip(client_host)


def _client_ip_from_websocket(websocket: WebSocket) -> str:
    forwarded = websocket.headers.get("x-forwarded-for")
    if forwarded:
        return _normalize_ip(forwarded.split(",")[0])
    client_host = websocket.client.host if websocket.client else "unknown"
    return _normalize_ip(client_host)


def _safe_filename(filename: str) -> str:
    cleaned = Path(filename).name
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", cleaned).strip("._")
    return cleaned or "file"


def _media_kind(mime_type: str) -> str:
    if mime_type.startswith("image/"):
        return "image"
    if mime_type.startswith("video/"):
        return "video"
    if mime_type.startswith("audio/"):
        return "audio"
    return "file"


def _clean_key_fingerprint(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip().lower()
    if not cleaned:
        return None
    if len(cleaned) > 256:
        return None
    if not re.fullmatch(r"[0-9a-f:-]+", cleaned):
        return None
    return cleaned


def _validate_public_key_payload(value: object) -> dict | None:
    if not isinstance(value, dict):
        return None
    allowed = {"kty", "crv", "x", "y", "ext", "key_ops"}
    unknown = set(value) - allowed
    if unknown:
        return None
    if value.get("kty") != "EC" or value.get("crv") != "P-256":
        return None
    if not isinstance(value.get("x"), str) or not isinstance(value.get("y"), str):
        return None
    return value


def _validate_encrypted_payload(value: object) -> dict | None:
    if not isinstance(value, dict):
        return None
    required = {
        "version",
        "alg",
        "curve",
        "sender_fingerprint",
        "recipient_fingerprint",
        "sender_public_jwk",
        "recipient_public_jwk",
    }
    if not required.issubset(value):
        return None
    if value.get("version") != 1:
        return None
    if value.get("alg") != "AES-GCM" or value.get("curve") != "P-256":
        return None
    sender_fp = _clean_key_fingerprint(value.get("sender_fingerprint"))
    recipient_fp = _clean_key_fingerprint(value.get("recipient_fingerprint"))
    if sender_fp is None or recipient_fp is None:
        return None
    sender_key = _validate_public_key_payload(value.get("sender_public_jwk"))
    recipient_key = _validate_public_key_payload(value.get("recipient_public_jwk"))
    if sender_key is None or recipient_key is None:
        return None
    normalized = dict(value)
    normalized["sender_fingerprint"] = sender_fp
    normalized["recipient_fingerprint"] = recipient_fp
    normalized["sender_public_jwk"] = sender_key
    normalized["recipient_public_jwk"] = recipient_key
    return normalized


def _has_nonempty_str_fields(payload: dict[str, object], field_names: set[str]) -> bool:
    for field in field_names:
        value = payload.get(field)
        if not isinstance(value, str) or not value.strip():
            return False
    return True


UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="WebChatLocalLan", version="1.0.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))
chat_manager = ChatManager(max_history=MAX_HISTORY_MESSAGES)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/health")
async def health() -> dict[str, int | str]:
    return {"status": "ok", "online_users": await chat_manager.online_count()}


@app.get("/api/users")
async def list_users() -> dict[str, list[dict]]:
    return {"users": await chat_manager.online_users()}


@app.post("/api/upload")
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
    recipient_id: str | None = Form(default=None),
    recipient_ip: str | None = Form(default=None),
    device_id: str | None = Form(default=None),
    caption: str | None = Form(default=None),
    encrypted_payload: str | None = Form(default=None),
) -> dict:
    sender_network_ip = _client_ip_from_request(request)
    sender_client_id = _pick_client_id(
        request_ip=sender_network_ip,
        provided_id=(request.headers.get("x-device-id") or device_id),
    )
    target_client_id = _normalize_recipient_id(recipient_id or recipient_ip)
    cleaned_name = _safe_filename(file.filename or "file")
    random_prefix = secrets.token_hex(8)
    stored_name = f"{random_prefix}_{cleaned_name}"
    dst_path = UPLOAD_DIR / stored_name

    total_size = 0
    try:
        with dst_path.open("wb") as output:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total_size += len(chunk)
                if total_size > MAX_UPLOAD_BYTES:
                    output.close()
                    dst_path.unlink(missing_ok=True)
                    raise HTTPException(
                        status_code=413,
                        detail=f"File quá lớn, tối đa {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
                    )
                output.write(chunk)
    finally:
        await file.close()

    if encrypted_payload:
        if target_client_id is None:
            raise HTTPException(status_code=400, detail="Tin nhắn E2EE cần recipient_id.")
        try:
            raw_payload = json.loads(encrypted_payload)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="encrypted_payload không hợp lệ.") from exc
        encrypted = _validate_encrypted_payload(raw_payload)
        if encrypted is None:
            raise HTTPException(status_code=400, detail="encrypted_payload thiếu hoặc sai định dạng.")
        file_required = {"file_iv", "file_aad", "metadata_iv", "metadata_aad", "metadata_ciphertext"}
        if not _has_nonempty_str_fields(encrypted, file_required):
            raise HTTPException(status_code=400, detail="encrypted_payload thiếu trường file E2EE.")

        attachment = Attachment(
            original_name="encrypted.bin",
            stored_name=stored_name,
            url=f"/uploads/{stored_name}",
            size=total_size,
            mime_type="application/octet-stream",
            kind="encrypted",
        )
        message = await chat_manager.send_encrypted_file(
            sender_ip=sender_client_id,
            recipient_ip=target_client_id,
            attachment=attachment,
            encrypted=encrypted,
        )
        return {"ok": True, "message": message.to_dict()}

    mime_type = file.content_type or mimetypes.guess_type(cleaned_name)[0] or "application/octet-stream"
    attachment = Attachment(
        original_name=cleaned_name,
        stored_name=stored_name,
        url=f"/uploads/{stored_name}",
        size=total_size,
        mime_type=mime_type,
        kind=_media_kind(mime_type),
    )

    message = await chat_manager.send_file(
        sender_ip=sender_client_id,
        recipient_ip=target_client_id,
        attachment=attachment,
        caption=(caption or "").strip() or None,
    )

    return {"ok": True, "message": message.to_dict()}


@app.websocket("/ws")
async def websocket_chat(websocket: WebSocket) -> None:
    await websocket.accept()
    client_network_ip = _client_ip_from_websocket(websocket)
    user_agent = websocket.headers.get("user-agent", "")
    client_id = _pick_client_id(
        request_ip=client_network_ip,
        provided_id=websocket.query_params.get("device_id"),
    )
    client_device_name = _normalize_device_name(websocket.query_params.get("device_name")) or client_id

    initial_state = await chat_manager.register(
        client_id,
        websocket,
        user_agent,
        network_ip=client_network_ip,
        device_name=client_device_name,
    )
    await websocket.send_json(
        {
            "type": "hello",
            "me": {
                "id": client_id,
                "ip": client_network_ip,
                "device_name": client_device_name,
            },
            "users": initial_state["users"],
            "messages": initial_state["messages"],
        }
    )

    try:
        while True:
            payload = await websocket.receive_json()
            event_type = (payload.get("type") or "").strip()

            if event_type == "send_message":
                text = (payload.get("text") or "").strip()
                if not text:
                    continue
                recipient_raw = payload.get("recipient_id") or payload.get("recipient_ip")
                target_id = _normalize_recipient_id(recipient_raw)
                await chat_manager.send_text(sender_ip=client_id, text=text, recipient_ip=target_id)
                continue

            if event_type == "send_encrypted_message":
                recipient_raw = payload.get("recipient_id") or payload.get("recipient_ip")
                target_id = _normalize_recipient_id(recipient_raw)
                encrypted = _validate_encrypted_payload(payload.get("encrypted"))
                if target_id is None or encrypted is None:
                    continue
                if not _has_nonempty_str_fields(encrypted, {"iv", "aad", "ciphertext"}):
                    continue
                await chat_manager.send_encrypted_text(
                    sender_ip=client_id,
                    recipient_ip=target_id,
                    encrypted=encrypted,
                )
                continue

            if event_type == "announce_key":
                public_key = _validate_public_key_payload(payload.get("public_key"))
                key_fingerprint = _clean_key_fingerprint(payload.get("key_fingerprint"))
                if public_key and key_fingerprint:
                    await chat_manager.update_identity_key(
                        client_id=client_id,
                        public_key=public_key,
                        key_fingerprint=key_fingerprint,
                    )
                continue

            if event_type == "typing":
                recipient_raw = payload.get("recipient_id") or payload.get("recipient_ip")
                target_id = _normalize_recipient_id(recipient_raw)
                is_typing = bool(payload.get("is_typing"))
                await chat_manager.send_typing(sender_ip=client_id, recipient_ip=target_id, is_typing=is_typing)
                continue

            if event_type == "ping":
                await websocket.send_json({"type": "pong"})
                continue

    except WebSocketDisconnect:
        pass
    finally:
        await chat_manager.unregister(client_id, websocket)
