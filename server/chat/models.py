"""Meeting Chat (spec §26–27). Meeting-scoped threads; every assistant
message stores its retrieved segment ids, validated citations, and an honest
`not_found` flag when the transcript does not contain the answer."""

from django.db import models

from groups.models import Group
from meetings.models import Meeting
from tenancy.models import WorkspaceScopedModel


class MeetingChatThread(WorkspaceScopedModel):
    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name="chat_threads")
    title = models.CharField(max_length=300, blank=True)

    class Meta:
        ordering = ["-created_at"]


class MeetingChatMessage(WorkspaceScopedModel):
    class Role(models.TextChoices):
        USER = "user"
        ASSISTANT = "assistant"

    thread = models.ForeignKey(
        MeetingChatThread, on_delete=models.CASCADE, related_name="messages"
    )
    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name="chat_messages")
    role = models.CharField(max_length=16, choices=Role.choices)
    text = models.TextField()
    # ids handed to the client for generation (user turns) / cited (assistant).
    retrieved_segment_ids = models.JSONField(default=list)
    citations = models.JSONField(default=list)
    not_found = models.BooleanField(default=False)

    class Meta:
        ordering = ["created_at"]


class GroupChatThread(WorkspaceScopedModel):
    group = models.ForeignKey(Group, on_delete=models.CASCADE, related_name="chat_threads")
    title = models.CharField(max_length=300, blank=True)

    class Meta:
        ordering = ["-created_at"]


class GroupChatMessage(WorkspaceScopedModel):
    """Group Intelligence turn (spec §28–29). Citations are typed
    {source_type, id, quote}; the scope indicator is derivable from `group`."""

    class Role(models.TextChoices):
        USER = "user"
        ASSISTANT = "assistant"

    thread = models.ForeignKey(
        GroupChatThread, on_delete=models.CASCADE, related_name="messages"
    )
    group = models.ForeignKey(Group, on_delete=models.CASCADE, related_name="chat_messages")
    role = models.CharField(max_length=16, choices=Role.choices)
    text = models.TextField()
    retrieved_sources = models.JSONField(default=list)
    citations = models.JSONField(default=list)
    not_found = models.BooleanField(default=False)

    class Meta:
        ordering = ["created_at"]
