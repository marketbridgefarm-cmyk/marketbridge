import React, { useEffect, useState } from 'react';
import { resolveAvatarUrl } from '../utils/avatarUrl.js';
import './AvatarFace.css';

// Lays a person's profile photo over the existing initials badge (.order-avatar, .rc-avatar, .sd-avatar,
// .od-party-avatar, .bb-avatar …). No photo, or a photo that fails to load → the initials underneath simply show.
export default function AvatarFace({ src }) {
  const url = resolveAvatarUrl(src);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url]);
  if (!url || failed) return null;
  return <img className="mbaf" src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}
