export const config = {
  // Apply to all paths except the Vercel internal ones and static health checks
  matcher: '/((?!_next|_vercel|.*\\..*).*)',
};

export default function middleware(request) {
  const authorization = request.headers.get('authorization');

  if (authorization) {
    const [scheme, encoded] = authorization.split(' ');
    if (scheme.toLowerCase() === 'basic') {
      try {
        const decoded = atob(encoded);
        const [user, password] = decoded.split(':');

        if (
          user === process.env.BASIC_AUTH_USER &&
          password === process.env.BASIC_AUTH_PASSWORD
        ) {
          // Allow the request to proceed
          return;
        }
      } catch (e) {
        console.error('Auth error:', e);
      }
    }
  }

  // Trigger login prompt
  return new Response('Authentication Required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Secure Area"',
    },
  });
}
