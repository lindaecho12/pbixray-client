export function printToolCallResult(result: any) {
  if (!result) return;
  const content = result.content || [];
  for (const item of content) {
    if (item && typeof item.text === 'string') {
      const txt = item.text;
      try {
        const parsed = JSON.parse(txt);
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log(txt);
      }
    } else {
      console.log(item);
    }
  }
}
