"""Merge automation schema heads into a single lineage.

Revision ID: 20260303_0002_merge_automation_heads
Revises: 0001_initial, 20260220_0001
Create Date: 2026-03-03 00:00:00.000000
"""

from __future__ import annotations

# revision identifiers, used by Alembic.
revision = "20260303_0002_merge_automation_heads"
down_revision = ("0001_initial", "20260220_0001")
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Merge revision: no-op by design.
    pass


def downgrade() -> None:
    # Merge revision: no-op by design.
    pass
