"""create automation_tasks table baseline

Revision ID: 0001_initial
Revises: None
Create Date: 2026-02-21 00:00:00.000000
"""

from __future__ import annotations

from alembic import context, op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    if not context.is_offline_mode():
        bind = op.get_bind()
        inspector = sa.inspect(bind)
        if "automation_tasks" in inspector.get_table_names():
            return

    op.create_table(
        "automation_tasks",
        sa.Column("task_id", sa.Text(), nullable=False),
        sa.Column("command_id", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("requested_by", sa.Text(), nullable=True),
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("started_at", sa.Text(), nullable=True),
        sa.Column("finished_at", sa.Text(), nullable=True),
        sa.Column("exit_code", sa.Integer(), nullable=True),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("output_tail", sa.Text(), nullable=False, server_default=""),
        sa.PrimaryKeyConstraint("task_id", name="pk_automation_tasks"),
    )


def downgrade() -> None:
    if not context.is_offline_mode():
        bind = op.get_bind()
        inspector = sa.inspect(bind)
        if "automation_tasks" not in inspector.get_table_names():
            return
    op.drop_table("automation_tasks")
