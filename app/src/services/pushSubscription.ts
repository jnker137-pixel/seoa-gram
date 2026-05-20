const VAPID_PUBLIC_KEY = 'BKMCVDQ4x3TccDE1Oi3MfrY-4i2fGWA0mPrdqf0DgaLX6movUljKBlMlMuzcp-kArUGydXRIYIeKZAXoPas-LEo';
const SUPABASE_URL = 'https://uxiymaeobmleshekvqvl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV4aXltYWVvYm1sZXNoZWt2cXZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1NTQ3OTYsImV4cCI6MjA4NzEzMDc5Nn0.cAltB-U4B7-38M065Cn30uwoPu-wzh62IkuDUT4rrAQ';

export async function subscribeToPush(clientId: string): Promise<string> {
  if (!('serviceWorker' in navigator)) throw new Error('serviceWorker 미지원');
  if (!('PushManager' in window)) throw new Error('PushManager 미지원');

  const registration = await navigator.serviceWorker.register('/seoa-gram/sw-push.js');
  await navigator.serviceWorker.ready;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(`알림 권한 거부: ${permission}`);

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    // applicationServerKey는 base64url 문자열 그대로 사용 (Uint8Array 변환 시 TS 타입 충돌)
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: VAPID_PUBLIC_KEY,
    });
  }

  const sub = subscription.toJSON();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      client_id: clientId,
      endpoint: subscription.endpoint,
      p256dh: sub.keys?.p256dh,
      auth: sub.keys?.auth,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase 저장 실패 (${res.status}): ${body}`);
  }

  return subscription.endpoint.slice(0, 40) + '...';
}
