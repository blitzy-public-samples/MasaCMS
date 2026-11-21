# Inputs of the network module.

variable "project_id" {
  description = "Project that owns the network."
  type        = string
}

variable "region" {
  description = "Region of the subnet, router and NAT."
  type        = string
}

variable "name" {
  description = "Base name for the network resources."
  type        = string
}

variable "subnet_cidr" {
  description = "Subnet CIDR; Direct VPC egress needs at least a /26."
  type        = string
}

variable "private_services_prefix_length" {
  description = "Prefix length of the private services access range for Cloud SQL."
  type        = number
  default     = 16
}
