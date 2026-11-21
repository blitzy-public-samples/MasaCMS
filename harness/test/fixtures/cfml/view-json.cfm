<!--- Admin view sample that answers JSON and aborts --->
<cfset request.layout=false>
<cfset data=structNew()>
<cfset data.status="ok">
<cfcontent type="application/json; charset=utf-8" reset="true"><cfoutput>#createObject("component","mura.json").encode(data)#</cfoutput><cfabort>
