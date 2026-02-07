from __future__ import annotations

import asyncio
import uuid
from collections import deque
from typing import Any

from fastapi import WebSocket

from .models import Attachment, ChatMessage, UserPresence, utc_now_iso


class ChatManager:
    def __init__(self, max_history: int = 500) -> None:
        self._clients: dict[str, set[WebSocket]] = {}
        self._presence: dict[str, UserPresence] = {}
        self._history: deque[ChatMessage] = deque(maxlen=max_history)
        self._lock = asyncio.Lock()

    async def register(self, ip: str, websocket: WebSocket, user_agent: str = "") -> dict[str, Any]:
        now = utc_now_iso()
        async with self._lock:
            sockets = self._clients.setdefault(ip, set())
            sockets.add(websocket)

            if ip in self._presence:
                presence = self._presence[ip]
                presence.last_seen = now
                presence.connections = len(sockets)
                if user_agent:
                    presence.user_agent = user_agent
            else:
                self._presence[ip] = UserPresence(
                    ip=ip,
                    first_seen=now,
                    last_seen=now,
                    connections=len(sockets),
                    user_agent=user_agent,
                )

            users = self._serialize_presence()
            messages = self._serialize_history_for(ip)

        await self.broadcast_presence(users)
        return {"users": users, "messages": messages}

    async def unregister(self, ip: str, websocket: WebSocket) -> None:
        now = utc_now_iso()
        should_broadcast = False

        async with self._lock:
            sockets = self._clients.get(ip)
            if sockets is None:
                return

            sockets.discard(websocket)
            should_broadcast = True

            if sockets:
                presence = self._presence[ip]
                presence.last_seen = now
                presence.connections = len(sockets)
            else:
                self._clients.pop(ip, None)
                self._presence.pop(ip, None)

            users = self._serialize_presence()

        if should_broadcast:
            await self.broadcast_presence(users)

    async def update_identity_key(
        self,
        ip: str,
        public_key: dict[str, Any] | None,
        key_fingerprint: str | None,
    ) -> None:
        async with self._lock:
            presence = self._presence.get(ip)
            if presence is None:
                return
            presence.public_key = public_key
            presence.key_fingerprint = key_fingerprint
            users = self._serialize_presence()
        await self.broadcast_presence(users)

    async def broadcast_presence(self, users: list[dict[str, Any]] | None = None) -> None:
        if users is None:
            async with self._lock:
                users = self._serialize_presence()
                targets = self._collect_sockets(set(self._clients))
        else:
            async with self._lock:
                targets = self._collect_sockets(set(self._clients))

        if not targets:
            return
        payload = {"type": "presence", "users": users}
        await self._send_many(targets, payload)

    async def send_text(self, sender_ip: str, text: str, recipient_ip: str | None = None) -> ChatMessage:
        message = ChatMessage(
            message_id=uuid.uuid4().hex,
            timestamp=utc_now_iso(),
            sender_ip=sender_ip,
            recipient_ip=recipient_ip,
            message_type="text",
            text=text,
        )
        await self._dispatch_message(message)
        return message

    async def send_encrypted_text(
        self,
        sender_ip: str,
        recipient_ip: str,
        encrypted: dict[str, Any],
    ) -> ChatMessage:
        message = ChatMessage(
            message_id=uuid.uuid4().hex,
            timestamp=utc_now_iso(),
            sender_ip=sender_ip,
            recipient_ip=recipient_ip,
            message_type="e2ee_text",
            encrypted=encrypted,
        )
        await self._dispatch_message(message)
        return message

    async def send_file(
        self,
        sender_ip: str,
        attachment: Attachment,
        recipient_ip: str | None = None,
        caption: str | None = None,
    ) -> ChatMessage:
        message = ChatMessage(
            message_id=uuid.uuid4().hex,
            timestamp=utc_now_iso(),
            sender_ip=sender_ip,
            recipient_ip=recipient_ip,
            message_type="file",
            text=caption,
            attachment=attachment,
        )
        await self._dispatch_message(message)
        return message

    async def send_encrypted_file(
        self,
        sender_ip: str,
        recipient_ip: str,
        attachment: Attachment,
        encrypted: dict[str, Any],
    ) -> ChatMessage:
        message = ChatMessage(
            message_id=uuid.uuid4().hex,
            timestamp=utc_now_iso(),
            sender_ip=sender_ip,
            recipient_ip=recipient_ip,
            message_type="e2ee_file",
            attachment=attachment,
            encrypted=encrypted,
        )
        await self._dispatch_message(message)
        return message

    async def send_typing(self, sender_ip: str, recipient_ip: str | None, is_typing: bool) -> None:
        async with self._lock:
            if recipient_ip:
                target_ips = {recipient_ip}
            else:
                target_ips = set(self._clients)
                target_ips.discard(sender_ip)
            targets = self._collect_sockets(target_ips)

        payload = {
            "type": "typing",
            "sender_ip": sender_ip,
            "recipient_ip": recipient_ip,
            "is_typing": is_typing,
        }
        await self._send_many(targets, payload)

    async def online_users(self) -> list[dict[str, Any]]:
        async with self._lock:
            return self._serialize_presence()

    async def online_count(self) -> int:
        async with self._lock:
            return len(self._presence)

    async def _dispatch_message(self, message: ChatMessage) -> None:
        async with self._lock:
            self._history.append(message)

            if message.recipient_ip:
                target_ips = {message.sender_ip, message.recipient_ip}
            else:
                target_ips = set(self._clients)

            targets = self._collect_sockets(target_ips)

        payload = {"type": "message", "message": message.to_dict()}
        await self._send_many(targets, payload)

    async def _send_many(self, sockets: list[WebSocket], payload: dict[str, Any]) -> None:
        for ws in sockets:
            try:
                await ws.send_json(payload)
            except Exception:
                # A dead websocket will be removed when disconnect is raised in endpoint loop.
                continue

    def _collect_sockets(self, ips: set[str]) -> list[WebSocket]:
        targets: list[WebSocket] = []
        for ip in ips:
            sockets = self._clients.get(ip)
            if sockets:
                targets.extend(sockets)
        return targets

    def _serialize_presence(self) -> list[dict[str, Any]]:
        users = [presence.to_dict() for presence in self._presence.values()]
        users.sort(key=lambda user: user["ip"])
        return users

    def _serialize_history_for(self, ip: str) -> list[dict[str, Any]]:
        visible = []
        for message in self._history:
            if message.recipient_ip is None:
                visible.append(message.to_dict())
                continue
            if ip == message.sender_ip or ip == message.recipient_ip:
                visible.append(message.to_dict())
        return visible
