from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

out = Path(__file__).resolve().parents[1] / 'docs' / 'er-diagram.png'
scale = 2
width, height = 1830, 1320
image = Image.new('RGB', (width * scale, height * scale), '#f7f9fc')
draw = ImageDraw.Draw(image)
font_path = '/System/Library/Fonts/Supplemental/Arial.ttf'
def font(size): return ImageFont.truetype(font_path, size * scale)
title, head, body, small = font(30), font(19), font(15), font(13)
boxes = {
 'USERS': (40, 100, ['id PK', 'email UK', 'token_hash UK'], '#e8eefb'),
 'CONNECTIONS': (490, 100, ['id PK / user_id FK', 'provider / external_account_id', 'credential / webhook_secret', 'status / bridge_hash', 'last_sync_at / last_event_at', 'subscription_status'], '#e4f0ff'),
 'CONVERSATIONS': (940, 100, ['id PK / user_id FK', 'connection_id FK / external_key', 'recipient_ref / display_name', 'attention / last_message_at'], '#e4f0ff'),
 'MESSAGES': (1390, 100, ['id PK / user_id FK', 'conversation_id FK / external_id', 'sender_name / direction', 'body / source_at'], '#e4f0ff'),
 'AUDIT': (40, 510, ['id PK / user_id FK', 'actor / entity_id', 'action / at'], '#edf0f6'),
 'INBOUND_EVENTS': (490, 510, ['id PK / user_id FK', 'connection_id FK', 'event_key UK / received_at'], '#edf0f6'),
 'COMMANDS': (940, 510, ['id PK / user_id FK', 'conversation_id / connection_id', 'request_id UK / recipient', 'body_hash / status', 'lease_until / error_code'], '#fff0dc'),
 'ATTEMPTS': (1390, 510, ['id PK / user_id FK', 'command_id FK / outcome', 'evidence / started_at', 'finished_at'], '#fff0dc'),
 'SYNC_STATE': (40, 920, ['connection_id PK, FK', 'user_id FK / status', 'last_started_at / completed_at', 'gap_possible / checked_rooms'], '#e8f5eb'),
 'CHATWORK_ROOMS': (490, 920, ['connection_id PK, FK', 'room_id PK / user_id FK', 'room_type / updated_at'], '#e8f5eb'),
 'TEAMS_SUBSCRIPTIONS': (940, 920, ['connection_id PK, FK', 'chat_id PK / user_id FK', 'subscription_id UK', 'expires_at / room_type'], '#e8f5eb'),
}
box_w, box_h = 390, 325
# Lines show primary relationships; exact cardinalities and constraints are in the Mermaid source.
def line(points, color='#8b9bb0'):
 draw.line([(x*scale,y*scale) for x,y in points], fill=color, width=3*scale, joint='curve')
line([(430,245),(490,245)])
line([(880,245),(940,245)])
line([(1330,245),(1390,245)])
line([(235,425),(235,510)])
line([(685,425),(685,510)])
line([(1135,425),(1135,510)])
line([(1330,675),(1390,675)])
line([(685,425),(685,875),(235,875),(235,920)], '#8bb49a')
line([(685,835),(685,920)], '#8bb49a')
line([(685,875),(1135,875),(1135,920)], '#8bb49a')
for name, (x, y, fields, accent) in boxes.items():
 x0,y0,x1,y1 = x*scale,y*scale,(x+box_w)*scale,(y+box_h)*scale
 draw.rounded_rectangle((x0,y0,x1,y1), radius=14*scale, fill='white', outline='#c7d3e1', width=2*scale)
 draw.rounded_rectangle((x0,y0,x1,(y+54)*scale), radius=14*scale, fill=accent)
 draw.rectangle((x0,(y+40)*scale,x1,(y+54)*scale), fill=accent)
 draw.text(((x+16)*scale,(y+14)*scale),name,font=head,fill='#263445')
 for i, field in enumerate(fields):
  draw.text(((x+16)*scale,(y+73+i*38)*scale),field,font=body,fill='#3f4d61')
draw.text((40*scale,25*scale),'UNIFIED INBOX  /  IMPLEMENTED ER DIAGRAM',font=title,fill='#21324c')
draw.text((40*scale,1270*scale),'11 tables  |  user_id on owned rows  |  unique keys suppress duplicate events and replies',font=small,fill='#596a7b')
image.resize((width,height),Image.Resampling.LANCZOS).save(out)
print(out)
