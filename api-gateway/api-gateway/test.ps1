for($i=0;$i -lt 12;$i++){(Invoke-WebRequest -Uri http://localhost:3000/api/products -UseBasicParsing).StatusCode}
