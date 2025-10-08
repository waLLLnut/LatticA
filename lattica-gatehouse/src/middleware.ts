import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  // actions.json 파일에 대한 CORS 헤더 추가
  if (request.nextUrl.pathname === '/actions.json') {
    const response = NextResponse.next()
    response.headers.set('Access-Control-Allow-Origin', '*')
    response.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Encoding, Accept-Encoding')
    return response
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/actions.json',
    '/api/actions/:path*',
    '/fhe/:path*'
  ]
}
