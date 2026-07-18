import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone

from groups.models import Group, Person
from tenancy.models import WorkspaceScopedModel


class Meeting(WorkspaceScopedModel):
    class Status(models.TextChoices):
        DRAFT = "draft"
        RECORDING = "recording"
        PROCESSING = "processing"
        COMPLETE = "complete"
        PARTIAL = "partially_complete"
        FAILED = "failed"

    group = models.ForeignKey(Group, on_delete=models.PROTECT, related_name="meetings")
    title = models.CharField(max_length=300)
    meeting_type = models.CharField(max_length=64, blank=True)
    scheduled_start = models.DateTimeField(null=True, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    duration_seconds = models.PositiveIntegerField(default=0)
    status = models.CharField(max_length=32, choices=Status.choices, default=Status.DRAFT)
    language = models.CharField(max_length=10, default="en")
    deleted_at = models.DateTimeField(null=True, blank=True)

    def __str__(self) -> str:
        return self.title


class MeetingParticipant(WorkspaceScopedModel):
    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name="participants")
    person = models.ForeignKey(Person, on_delete=models.PROTECT, related_name="meetings")
    speaker_label = models.CharField(max_length=64, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["meeting", "person"], name="uniq_meeting_participant"
            )
        ]


class Recording(WorkspaceScopedModel):
    class Mode(models.TextChoices):
        MIC = "mic"
        SYSTEM = "system"
        MIXED = "mixed"
        UPLOAD = "upload"

    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name="recordings")
    storage_path = models.CharField(max_length=500)
    mime_type = models.CharField(max_length=100)
    mode = models.CharField(max_length=16, choices=Mode.choices, default=Mode.MIC)
    duration_seconds = models.PositiveIntegerField(default=0)
    checksum = models.CharField(max_length=128, blank=True)


class ConsentRecord(WorkspaceScopedModel):
    class Method(models.TextChoices):
        VERBAL = "verbal"
        WRITTEN = "written"
        ANNOUNCEMENT = "announcement"
        NOT_REQUIRED = "not_required"

    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name="consents")
    method = models.CharField(max_length=32, choices=Method.choices)
    policy_applied = models.CharField(max_length=200, blank=True)
    note = models.TextField(blank=True)


class TranscriptSegment(WorkspaceScopedModel):
    """One diarized transcript span. `dedupe_key` makes reprocessing
    idempotent (spec §22). Embeddings live in a separate column added in the
    pgvector migration when running on Postgres."""

    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name="segments")
    sequence = models.PositiveIntegerField()
    speaker_label = models.CharField(max_length=64, blank=True)
    speaker_confidence = models.FloatField(null=True, blank=True)
    start_ms = models.PositiveIntegerField()
    end_ms = models.PositiveIntegerField()
    original_text = models.TextField()
    corrected_text = models.TextField(blank=True)
    language = models.CharField(max_length=10, default="en")
    confidence = models.FloatField(null=True, blank=True)
    dedupe_key = models.CharField(max_length=128, unique=True)

    class Meta:
        ordering = ["sequence"]
        constraints = [
            models.UniqueConstraint(
                fields=["meeting", "sequence"], name="uniq_meeting_segment_sequence"
            )
        ]

    @property
    def text(self) -> str:
        return self.corrected_text or self.original_text


class ProcessingJob(WorkspaceScopedModel):
    """State machine row per (meeting, stage) — see docs/ARCHITECTURE.md §3."""

    class Stage(models.TextChoices):
        VALIDATED = "validated"
        STORED = "stored"
        TRANSCRIBED = "transcribed"
        DIARIZED = "diarized"
        SEGMENTED = "segmented"
        EMBEDDED = "embedded"
        CONTEXT_RETRIEVED = "context_retrieved"
        SUMMARIZED = "summarized"
        ENTITIES_EXTRACTED = "entities_extracted"
        MEMORY_SUGGESTED = "memory_suggested"
        CHAT_INDEXED = "chat_indexed"
        GROUP_INDEX_UPDATED = "group_index_updated"
        NOTIFIED = "notified"

    class Status(models.TextChoices):
        PENDING = "pending"
        RUNNING = "running"
        COMPLETE = "complete"
        FAILED = "failed"

    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name="jobs")
    stage = models.CharField(max_length=32, choices=Stage.choices)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    attempt = models.PositiveIntegerField(default=0)
    error = models.TextField(blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["meeting", "stage"], name="uniq_meeting_stage")
        ]


class MeetingShare(WorkspaceScopedModel):
    """Basic sharing (spec §34): workspace-wide, to a specific user, or an
    expiring external link. External viewers only ever see the external-safe
    summary variant — Group context is excluded by default."""

    class Scope(models.TextChoices):
        WORKSPACE = "workspace"
        USER = "user"
        EXTERNAL_LINK = "external_link"

    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name="shares")
    scope = models.CharField(max_length=16, choices=Scope.choices)
    shared_with = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, null=True, blank=True,
        related_name="meeting_shares",
    )
    token = models.UUIDField(default=uuid.uuid4, unique=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    @property
    def is_valid(self) -> bool:
        if self.revoked_at is not None:
            return False
        return self.expires_at is None or self.expires_at > timezone.now()
