#!/usr/bin/env node
/**
 * Standalone entry point for status. The flow lives in ../status.mjs so the CLI can
 * run the identical code path in-process; here emit()/fail() write JSON to
 * stdout and set the exit code, as documented.
 */
import { run } from '../status.mjs';
import { fail } from '../lib/output.mjs';

run().catch((err) => fail(err));
