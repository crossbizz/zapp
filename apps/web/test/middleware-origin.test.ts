import assert from 'node:assert/strict';
import test from 'node:test';

import { NextRequest } from 'next/server';

import { loginUrl } from '../src/middleware.js';

void test('keeps an unauthenticated redirect on the browser-visible local origin', () => {
  const originalAppBaseUrl = process.env['NEXT_PUBLIC_APP_BASE_URL'];
  process.env['NEXT_PUBLIC_APP_BASE_URL'] = 'http://127.0.0.1:3000';
  const request = new NextRequest('http://localhost:3000/projects/proj_example');

  try {
    assert.equal(loginUrl(request).href, 'http://127.0.0.1:3000/login');
  } finally {
    if (originalAppBaseUrl === undefined) delete process.env['NEXT_PUBLIC_APP_BASE_URL'];
    else process.env['NEXT_PUBLIC_APP_BASE_URL'] = originalAppBaseUrl;
  }
});
