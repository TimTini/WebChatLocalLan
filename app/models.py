from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(slots=True)
class UserPresence:
    ip: str
    first_seen: str
    last_seen: str
    connections: int
    user_agent: str = ""
    network_ip: str = ""
    device_name: str = ""
    public_key: dict[str, Any] | None = None
    key_fingerprint: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ip": self.ip,
            "first_seen": self.first_seen,
            "last_seen": self.last_seen,
            "connections": self.connections,
            "user_agent": self.user_agent,
            "network_ip": self.network_ip,
            "device_name": self.device_name,
            "public_key": self.public_key,
            "key_fingerprint": self.key_fingerprint,
        }


@dataclass(slots=True)
class Attachment:
    original_name: str
    stored_name: str
    url: str
    size: int
    mime_type: str
    kind: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "original_name": self.original_name,
            "stored_name": self.stored_name,
            "url": self.url,
            "size": self.size,
            "mime_type": self.mime_type,
            "kind": self.kind,
        }


@dataclass(slots=True)
class ChatMessage:
    message_id: str
    timestamp: str
    sender_ip: str
    recipient_ip: str | None
    message_type: str
    text: str | None = None
    attachment: Attachment | None = None
    encrypted: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "message_id": self.message_id,
            "timestamp": self.timestamp,
            "sender_ip": self.sender_ip,
            "recipient_ip": self.recipient_ip,
            "message_type": self.message_type,
            "text": self.text,
            "attachment": self.attachment.to_dict() if self.attachment else None,
            "encrypted": self.encrypted,
        }
