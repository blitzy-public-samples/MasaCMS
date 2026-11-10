<!--- Schema update sample in the core/mura/dbUpdates style --->
<cfquery>
CREATE TABLE tfixturemigrated (
	migratedID char(35) NOT NULL,
	siteID nvarchar(25) NULL,
	label nvarchar(50) NULL
)
</cfquery>

<cfscript>
	dbUtility.setTable("tfixture")
	.addColumn(column="notes",datatype="longtext")
	.addColumn(column="sortOrder",datatype="int",default=0);
</cfscript>
