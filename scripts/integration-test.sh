#!/usr/bin/env bash
# arch-graph integration test
# Runs install→init→build→stats→queries→integrations on a synthetic NestJS fixture.
#
# Flags:
#   --remote   clone from github instead of using the current repo
#   --keep     preserve the workdir after the run (for debugging)

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

REMOTE=0
KEEP=0
for arg in "$@"; do
    case "$arg" in
        --remote) REMOTE=1 ;;
        --keep)   KEEP=1 ;;
        *) echo "unknown flag: $arg" >&2; exit 1 ;;
    esac
done

# ---------------------------------------------------------------------------
# Sandbox
# ---------------------------------------------------------------------------

WORK=$(mktemp -d /tmp/arch-graph-test.XXXXXX)
export ARCH_GRAPH_HOME="$WORK/.arch-graph"
export ARCH_GRAPH_BIN_DIR="$WORK/bin"
export PATH="$WORK/bin:$PATH"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

on_exit() {
    local code=$?
    if [ $code -ne 0 ]; then
        echo ""
        echo "FAIL — workdir preserved for debugging: $WORK"
    elif [ $KEEP -eq 1 ]; then
        echo ""
        echo "(--keep) workdir preserved: $WORK"
    else
        rm -rf "$WORK"
    fi
}
trap 'on_exit $?' EXIT

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

PASS_COUNT=0
TOTAL_STEPS=6

step_start() {
    local num=$1 label=$2
    # pad label to 40 chars
    printf "[%d/%d] %-40s" "$num" "$TOTAL_STEPS" "$label"
    STEP_T0=$SECONDS
}

step_ok() {
    local elapsed=$(( SECONDS - STEP_T0 ))
    printf " OK (%ds)\n" "$elapsed"
    (( PASS_COUNT++ )) || true
}

fail() {
    local msg=$1
    echo ""
    echo "FAILED: $msg"
    echo "workdir: $WORK"
    exit 1
}

assert_file_exists() {
    local f=$1 ctx=${2:-}
    [ -f "$f" ] || fail "expected file not found: $f${ctx:+ ($ctx)}"
}

assert_nonempty() {
    local f=$1 ctx=${2:-}
    [ -s "$f" ] || fail "file is empty: $f${ctx:+ ($ctx)}"
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

if ! command -v jq >/dev/null 2>&1; then
    echo "error: jq is required but not found. Install it (brew install jq / apt install jq)." >&2
    exit 1
fi

if ! command -v node >/dev/null 2>&1; then
    echo "error: node is required but not found." >&2
    exit 1
fi

echo "arch-graph integration test"
echo "──────────────────────────────────────────"

# ---------------------------------------------------------------------------
# Step 1: Install
# ---------------------------------------------------------------------------

step_start 1 "install"

mkdir -p "$WORK/bin"

if [ $REMOTE -eq 1 ]; then
    SRC_DIR="$WORK/src"
    git clone https://github.com/roman-dubovik/arch-graph.git "$SRC_DIR" --quiet
    INSTALL_SCRIPT="$SRC_DIR/scripts/install.sh"
else
    INSTALL_SCRIPT="$REPO_DIR/scripts/install.sh"
fi

ARCH_GRAPH_GIT="${ARCH_GRAPH_GIT:-}" bash "$INSTALL_SCRIPT" >/dev/null 2>&1 \
    || fail "install.sh exited non-zero"

command -v arch-graph >/dev/null 2>&1 \
    || fail "arch-graph not found on PATH after install (PATH=$PATH)"

# Binary must resolve inside our sandbox bin dir
ARCH_BIN=$(command -v arch-graph)
echo "$ARCH_BIN" | grep -q "$WORK/bin" \
    || fail "arch-graph resolves to $ARCH_BIN (expected inside $WORK/bin)"

arch-graph --help >/dev/null 2>&1 \
    || fail "arch-graph --help exited non-zero"

step_ok

# ---------------------------------------------------------------------------
# Fixture: create synthetic NestJS project
# ---------------------------------------------------------------------------

FIXTURE="$WORK/fixture"
mkdir -p "$FIXTURE/apps/api/src/queue"
mkdir -p "$FIXTURE/apps/api/src/services"
mkdir -p "$FIXTURE/apps/api/src/users"
mkdir -p "$FIXTURE/apps/api/src/nats"
mkdir -p "$FIXTURE/libs/shared"

# app.module.ts
cat > "$FIXTURE/apps/api/src/app.module.ts" <<'EOF'
import { Module } from '@nestjs/common';
import { QueueModule } from './queue/queue.module';

@Module({
    imports: [QueueModule],
})
export class AppModule {}
EOF

# queue.module.ts
cat > "$FIXTURE/apps/api/src/queue/queue.module.ts" <<'EOF'
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';

@Module({
    imports: [
        BullModule.registerQueue({ name: 'email-queue' }),
    ],
    exports: [BullModule],
})
export class QueueModule {}
EOF

# email.processor.ts
cat > "$FIXTURE/apps/api/src/queue/email.processor.ts" <<'EOF'
import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';

@Processor('email-queue')
export class EmailProcessor {
    @Process()
    async handleEmailJob(job: Job): Promise<void> {
        // process email job
    }
}
EOF

# notification.service.ts
cat > "$FIXTURE/apps/api/src/services/notification.service.ts" <<'EOF'
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

@Injectable()
export class NotificationService {
    constructor(
        @InjectQueue('email-queue') private readonly emailQueue: Queue,
    ) {}

    async sendNotification(to: string, message: string): Promise<void> {
        await this.emailQueue.add({ to, message });
    }
}
EOF

# users.controller.ts
cat > "$FIXTURE/apps/api/src/users/users.controller.ts" <<'EOF'
import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';

@Controller()
export class UsersController {
    constructor(
        @InjectRepository(User)
        private readonly userRepository: Repository<User>,
    ) {}

    @MessagePattern('user.created')
    async handleUserCreated(data: { id: string; email: string }): Promise<void> {
        // handle user created event
    }
}
EOF

# user.entity.ts
cat > "$FIXTURE/apps/api/src/users/user.entity.ts" <<'EOF'
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class User {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    email: string;
}
EOF

# billing.service.ts
cat > "$FIXTURE/apps/api/src/services/billing.service.ts" <<'EOF'
import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';

@Injectable()
export class BillingService {
    constructor(private readonly httpService: HttpService) {}

    async chargeBilling(amount: number): Promise<void> {
        await this.httpService.get('https://billing.example.com/charge').toPromise();
    }
}
EOF

# nats.service.ts
cat > "$FIXTURE/apps/api/src/nats/nats.service.ts" <<'EOF'
import { Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Inject } from '@nestjs/common';

@Injectable()
export class NatsService {
    constructor(
        @Inject('NATS_CLIENT') private readonly client: ClientProxy,
    ) {}

    async publishUserCreated(payload: { id: string; email: string }): Promise<void> {
        this.client.emit('user.created', payload);
    }
}
EOF

# libs/shared/index.ts
cat > "$FIXTURE/libs/shared/index.ts" <<'EOF'
export * from './shared.service';
EOF

cat > "$FIXTURE/libs/shared/shared.service.ts" <<'EOF'
export class SharedService {
    greet(): string {
        return 'hello';
    }
}
EOF

# tsconfig.base.json
cat > "$FIXTURE/tsconfig.base.json" <<'EOF'
{
    "compilerOptions": {
        "paths": {
            "@scope/shared": ["libs/shared/index.ts"],
            "@scope/shared/*": ["libs/shared/*"]
        }
    }
}
EOF

# package.json
cat > "$FIXTURE/package.json" <<'EOF'
{
    "name": "nestjs-fixture",
    "version": "1.0.0",
    "private": true
}
EOF

# ---------------------------------------------------------------------------
# Step 2: Init
# ---------------------------------------------------------------------------

step_start 2 "init"

cd "$FIXTURE"

# Non-TTY → writes template config
echo "" | arch-graph init >/dev/null 2>&1 \
    || fail "arch-graph init exited non-zero"

assert_file_exists "$FIXTURE/arch-graph.config.ts" "arch-graph init"

# Patch config to point at our fixture structure.
# NOTE: We use `export default { ... }` (no `import { defineConfig }`) because
# the arch-graph package is not published to npm and the install only places the
# CLI binary on PATH — it does not add itself to node_modules of the user's project.
# The loadConfig function accepts any plain exported object that satisfies
# ArchGraphConfig (the validateConfig check is duck-typed, not class-based).
cat > "$FIXTURE/arch-graph.config.ts" <<'EOF'
export default {
    id: 'nestjs-fixture',
    root: '.',
    appsGlob: 'apps/*',
    libsGlob: 'libs/**',
    nats: {
        wrapperPublishApis: [],
        wrapperSubscribeApis: [],
    },
    imports: {},
};
EOF

step_ok

# ---------------------------------------------------------------------------
# Step 3: Build
# ---------------------------------------------------------------------------

step_start 3 "build"

cd "$FIXTURE"

arch-graph build >/dev/null 2>&1 \
    || fail "arch-graph build exited non-zero"

for f in graph.json diagnostics.json validation.json graph.mermaid; do
    assert_file_exists "$FIXTURE/arch-graph-out/$f" "build output"
    assert_nonempty    "$FIXTURE/arch-graph-out/$f" "build output"
done

step_ok

# ---------------------------------------------------------------------------
# Step 4: Stats
# ---------------------------------------------------------------------------

step_start 4 "stats"

cd "$FIXTURE"

STATS_JSON=$(arch-graph stats --json 2>&1)

echo "$STATS_JSON" | jq -e '.totals.nodes > 0 and .totals.edges > 0' >/dev/null \
    || fail "stats: expected totals.nodes > 0 and totals.edges > 0. Got: $STATS_JSON"

echo "$STATS_JSON" | jq -e '.nodes.service > 0'   >/dev/null || fail "stats: no 'service' nodes found"
echo "$STATS_JSON" | jq -e '.nodes.queue > 0'     >/dev/null || fail "stats: no 'queue' nodes found"
echo "$STATS_JSON" | jq -e '.nodes["db-table"] > 0' >/dev/null || fail "stats: no 'db-table' nodes found"
echo "$STATS_JSON" | jq -e '.nodes["nats-subject"] > 0' >/dev/null || fail "stats: no 'nats-subject' nodes found"
echo "$STATS_JSON" | jq -e '.nodes.module > 0'    >/dev/null || fail "stats: no 'module' nodes found"

step_ok

# ---------------------------------------------------------------------------
# Step 5: Queries
# ---------------------------------------------------------------------------

step_start 5 "queries"

cd "$FIXTURE"

# who-publishes user.created
WHO_PUB=$(arch-graph who-publishes user.created --json 2>&1)
echo "$WHO_PUB" | jq -e '.found == true and ((.results // []) | length > 0)' >/dev/null \
    || fail "who-publishes user.created: expected found=true with results. Got: $WHO_PUB"

# queue-producers email-queue
QUEUE_PROD=$(arch-graph queue-producers email-queue --json 2>&1)
echo "$QUEUE_PROD" | jq -e '.found == true' >/dev/null \
    || fail "queue-producers email-queue: expected found=true. Got: $QUEUE_PROD"

# table-users user  (TypeORM User entity maps to 'user' table by default)
TABLE=$(arch-graph table-users user --json 2>&1)
echo "$TABLE" | jq -e '.found == true' >/dev/null \
    || fail "table-users user: expected found=true. Got: $TABLE"

step_ok

# ---------------------------------------------------------------------------
# Step 6: Integrations (claude + hook)
# ---------------------------------------------------------------------------

step_start 6 "integrations"

cd "$FIXTURE"

# -- claude install --
arch-graph claude install >/dev/null 2>&1 \
    || fail "arch-graph claude install exited non-zero"

assert_file_exists "$FIXTURE/CLAUDE.md" "claude install"
grep -q "<!-- arch-graph:start -->" "$FIXTURE/CLAUDE.md" \
    || fail "CLAUDE.md missing arch-graph marker after install"

# -- git init + hook install --
git -C "$FIXTURE" init --quiet 2>/dev/null
git -C "$FIXTURE" config user.email "test@example.com"
git -C "$FIXTURE" config user.name  "Integration Test"

arch-graph hook install >/dev/null 2>&1 \
    || fail "arch-graph hook install exited non-zero"

assert_file_exists "$FIXTURE/.git/hooks/pre-commit" "hook install"
grep -q "# >>> arch-graph >>>" "$FIXTURE/.git/hooks/pre-commit" \
    || fail ".git/hooks/pre-commit missing arch-graph marker after install"

# -- hook status --
arch-graph hook status >/dev/null 2>&1 \
    || fail "arch-graph hook status exited non-zero"

# -- claude uninstall --
arch-graph claude uninstall >/dev/null 2>&1 \
    || fail "arch-graph claude uninstall exited non-zero"

if [ -f "$FIXTURE/CLAUDE.md" ]; then
    grep -q "<!-- arch-graph:start -->" "$FIXTURE/CLAUDE.md" \
        && fail "CLAUDE.md still contains arch-graph marker after uninstall"
fi

# -- hook uninstall --
arch-graph hook uninstall >/dev/null 2>&1 \
    || fail "arch-graph hook uninstall exited non-zero"

if [ -f "$FIXTURE/.git/hooks/pre-commit" ]; then
    grep -q "# >>> arch-graph >>>" "$FIXTURE/.git/hooks/pre-commit" \
        && fail "pre-commit still contains arch-graph marker after uninstall"
fi

step_ok

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo "──────────────────────────────────────────"
TOTAL_TIME=$SECONDS
WORKDIR_MSG="$WORK, removed"
[ $KEEP -eq 1 ] && WORKDIR_MSG="$WORK, kept (--keep)"

echo "PASS in ${TOTAL_TIME}s (workdir: $WORKDIR_MSG)"
