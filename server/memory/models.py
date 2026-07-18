"""Group Memory (spec §6–9, docs/DATA-MODEL.md "Memory").

Only `approved` (and unexpired `temporary`) memories may influence AI
output. Nothing is silently overwritten: replacement marks the old row
superseded and every edit writes a MemoryVersion row.
"""

from django.db import models
from django.utils import timezone

from groups.models import Group
from meetings.models import Meeting
from tenancy.models import WorkspaceScopedModel

CATEGORIES = [
    "fact", "goal", "requirement", "decision", "preference", "constraint",
    "responsibility", "client_expectation", "technical", "process", "risk",
    "historical", "deadline", "scope", "terminology",
]
CATEGORY_CHOICES = [(c, c) for c in CATEGORIES]


class GroupMemory(WorkspaceScopedModel):
    class Status(models.TextChoices):
        APPROVED = "approved"
        TEMPORARY = "temporary"
        DISPUTED = "disputed"
        OUTDATED = "outdated"
        SUPERSEDED = "superseded"
        REJECTED = "rejected"
        ARCHIVED = "archived"

    group = models.ForeignKey(Group, on_delete=models.CASCADE, related_name="memories")
    statement = models.TextField()
    category = models.CharField(max_length=32, choices=CATEGORY_CHOICES)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.APPROVED)
    citations = models.JSONField(default=list)
    source_meeting = models.ForeignKey(
        Meeting, on_delete=models.SET_NULL, null=True, blank=True, related_name="memories"
    )
    confidence = models.FloatField(null=True, blank=True)
    approved_by = models.ForeignKey(
        "tenancy.User", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    approved_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)  # temporary memories
    version = models.PositiveIntegerField(default=1)
    superseded_by = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True, related_name="supersedes"
    )
    embedding = models.JSONField(null=True, blank=True)
    embedding_provider = models.CharField(max_length=32, blank=True)

    class Meta:
        ordering = ["-created_at"]

    @property
    def is_active(self) -> bool:
        if self.status == self.Status.APPROVED:
            return True
        if self.status == self.Status.TEMPORARY:
            return self.expires_at is None or self.expires_at > timezone.now()
        return False

    @classmethod
    def active(cls, group):
        """The only memories allowed to influence AI output (spec §9)."""
        now = timezone.now()
        return cls.objects.filter(group=group).filter(
            models.Q(status=cls.Status.APPROVED)
            | models.Q(status=cls.Status.TEMPORARY, expires_at__isnull=True)
            | models.Q(status=cls.Status.TEMPORARY, expires_at__gt=now)
        )


class MemoryVersion(WorkspaceScopedModel):
    memory = models.ForeignKey(GroupMemory, on_delete=models.CASCADE, related_name="versions")
    version = models.PositiveIntegerField()
    statement = models.TextField()
    category = models.CharField(max_length=32)
    status = models.CharField(max_length=16)
    changed_by = models.ForeignKey(
        "tenancy.User", on_delete=models.SET_NULL, null=True, related_name="+"
    )
    note = models.CharField(max_length=300, blank=True)

    class Meta:
        ordering = ["version"]
        constraints = [
            models.UniqueConstraint(fields=["memory", "version"], name="uniq_memory_version")
        ]


class MemorySuggestion(WorkspaceScopedModel):
    class Resolution(models.TextChoices):
        PENDING = "pending"
        APPROVED = "approved"
        EDITED = "edited"
        REJECTED = "rejected"
        TEMPORARY = "temporary"
        MERGED = "merged"
        REPLACED = "replaced"

    group = models.ForeignKey(Group, on_delete=models.CASCADE, related_name="memory_suggestions")
    meeting = models.ForeignKey(
        Meeting, on_delete=models.CASCADE, related_name="memory_suggestions"
    )
    statement = models.TextField()
    category = models.CharField(max_length=32, choices=CATEGORY_CHOICES)
    citations = models.JSONField(default=list)
    confidence = models.FloatField(null=True, blank=True)
    # ids of active memories this suggestion likely conflicts with
    conflict_candidates = models.JSONField(default=list)
    resolution = models.CharField(
        max_length=16, choices=Resolution.choices, default=Resolution.PENDING
    )
    resolved_by = models.ForeignKey(
        "tenancy.User", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    resolved_at = models.DateTimeField(null=True, blank=True)
    memory = models.ForeignKey(
        GroupMemory, on_delete=models.SET_NULL, null=True, blank=True, related_name="from_suggestions"
    )
    dedupe_key = models.CharField(max_length=128, unique=True)

    class Meta:
        ordering = ["created_at"]


class MemoryConflict(WorkspaceScopedModel):
    class Status(models.TextChoices):
        OPEN = "open"
        RESOLVED = "resolved"

    class Action(models.TextChoices):
        KEEP_EXISTING = "keep_existing"
        REPLACE_EXISTING = "replace_existing"
        KEEP_BOTH = "keep_both"

    group = models.ForeignKey(Group, on_delete=models.CASCADE, related_name="memory_conflicts")
    existing_memory = models.ForeignKey(
        GroupMemory, on_delete=models.CASCADE, related_name="conflicts"
    )
    suggestion = models.ForeignKey(
        MemorySuggestion, on_delete=models.CASCADE, related_name="conflicts"
    )
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.OPEN)
    resolution_action = models.CharField(max_length=32, choices=Action.choices, blank=True)
    note = models.TextField(blank=True)
    resolved_by = models.ForeignKey(
        "tenancy.User", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["existing_memory", "suggestion"], name="uniq_memory_conflict_pair"
            )
        ]
