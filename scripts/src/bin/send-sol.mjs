#!/usr/bin/env node
/**
 * Standalone entry point for send-sol. The flow lives in ../send-sol.mjs so the CLI can
 * run the identical code path in-process; here emit()/fail() write JSON to
 * stdout and set the exit code, as documented.
 */
import { run } from '../send-sol.mjs';
import { fail } from '../lib/output.mjs';

run().catch((err) => fail(err));
