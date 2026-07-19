You are resolving a PHP method call to the method definition it refers to.

Respond with ONLY a JSON object, no prose, no markdown fences:
{"found": true|false, "file": "<repo-relative path>", "class": "<class>", "method": "<method>", "confidence": "high"|"low"}
Set found=false (and confidence="low") if you are not sure. Only answer found=true with confidence="high" when you are confident the file/class/method exists and is the real target.
